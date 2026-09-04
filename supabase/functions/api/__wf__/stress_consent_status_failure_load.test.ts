/**
 * Stress: `GET /v1/me/consent/status` — failure injection + load, L1-only
 * boot (no Upstash configured; the Redis-enabled matrix lives in
 * stress_consent_status_redis.test.ts because cache.ts fixes that at import).
 *
 * The REAL handler runs in-process (stress_consent_status_harness.ts). Three
 * campaigns, every one seeded and replayable:
 *
 *   fault matrix  — Supabase Auth, PostgREST and RevenueCat each made to
 *                   refuse / fail / hang / answer garbage in turn; every case
 *                   asserts the user-visible error class (401 credential,
 *                   503 retryable + Retry-After, 429, 500) and that the next
 *                   healthy request recovers.
 *   load          — STRESS_ITER seeded requests over a seeded population with
 *                   a seeded fault mix; p50/p95 latency, exact Supabase
 *                   round trips per request (>3 on the hot path is a
 *                   finding), every 200 body checked against the oracle fold.
 *   L1 memory     — STRESS_USERS distinct users through the cold path; heap
 *                   before/after and the auth-cache cap observed behaviourally.
 *
 *   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json stress_consent_status_failure_load.test.ts
 *   STRESS_ITER=1000 STRESS_USERS=20000 STRESS_SEED=20260904 deno test -A --no-check --v8-flags=--expose-gc --config deno.json stress_consent_status_failure_load.test.ts
 *   STRESS_CASE=D23 STRESS_STRICT=1 deno test -A --no-check --config deno.json stress_consent_status_failure_load.test.ts --filter "fault matrix"
 *
 * STRESS_ITER ≥ 1000 also runs the multi-second `fullOnly` cases; STRESS_STRICT=1
 * turns known findings into assertion failures; STRESS_CASE=<id,...> runs only those.
 *
 * Results: artifacts/stress-consent-status/latest/*.json (STRESS_OUT_DIR overrides).
 */
import { assert, assertEquals } from "@std/assert";
import {
  assertInvariants,
  type CaseOutcome,
  classify,
  countBy,
  fakeJwt,
  type FaultSpec,
  histogram,
  type Invariant,
  type LedgerRow,
  loadStressHarness,
  oracleFold,
  percentile,
  Prng,
  rawRequest,
  replayCommand,
  requestFor,
  seededLedger,
  seededUser,
  STRESS_CASE,
  STRESS_ITER,
  STRESS_SEED,
  STRESS_USERS,
  type StressHarness,
  type StressUser,
  SUPABASE_URL,
  type Upstream,
  writeJson,
} from "./stress_consent_status_harness.ts";

const FILE = "stress_consent_status_failure_load.test.ts";
const GENERIC_503 = "is temporarily unavailable. Please try again.";
const AUTH_DEADLINE_MS = 300;

// ─── fault matrix ────────────────────────────────────────────────────────────

interface Expect {
  status: number;
  errorClass: CaseOutcome["errorClass"];
  /** Exact Retry-After value, "any" for present-with-any-value, null for absent. */
  retryAfter?: string | "any" | null;
  authCalls?: number | [number, number];
  postgrestCalls?: number;
  maxPostgrestCalls?: number;
  revenuecatCalls?: 0;
  minLatencyMs?: number;
  maxLatencyMs?: number;
  /** Strings that must NOT appear in the response body (server detail). */
  noLeak?: string[];
  /** Substring the user-facing message must contain. */
  message?: string;
  /** Body must equal the oracle fold of this ledger. */
  oracleOf?: LedgerRow[];
  /** A server-side error line containing this fragment must have been logged. */
  loggedDetail?: string;
}

interface FaultCase {
  id: string;
  title: string;
  upstream: Upstream | "route" | "mixed";
  fault: string;
  /** Known finding id: the case is reported, not asserted (STRESS_STRICT asserts). */
  finding?: string;
  /** Auth deadline for this case (default AUTH_DEADLINE_MS). */
  deadlineMs?: number;
  /** Multi-second case: only runs in the full campaign (STRESS_ITER ≥ 1000). */
  fullOnly?: boolean;
  run: (
    h: StressHarness,
    prng: Prng,
  ) => Promise<{ req: Request; expect: Expect; recover?: () => Promise<Request> }>;
}

function inRange(value: number, spec: number | [number, number]): boolean {
  return Array.isArray(spec) ? value >= spec[0] && value <= spec[1] : value === spec;
}

async function newUser(
  h: StressHarness,
  prng: Prng,
  index: number,
  ledger?: LedgerRow[],
): Promise<StressUser> {
  const user = seededUser(prng, index);
  h.addUser(user, ledger ?? seededLedger(prng, user.id));
  return await Promise.resolve(user);
}

/** Verify once so the bearer is in the L1 auth cache (isolates DB faults). */
async function warm(h: StressHarness, user: StressUser): Promise<void> {
  const { response, calls } = await h.request(requestFor(user));
  assertEquals(response.status, 200, "warm-up request");
  await response.body?.cancel();
  assertEquals(countBy(calls, "auth"), 1, "warm-up verified the bearer once");
}

const http = (status: number, json?: unknown, headers?: Record<string, string>): FaultSpec =>
  json === undefined ? { kind: "http", status, headers } : { kind: "http", status, json, headers };
const raw = (status: number, body: string, headers?: Record<string, string>): FaultSpec => ({
  kind: "http",
  status,
  body,
  headers,
});

const CASES: FaultCase[] = [
  // ── Supabase Auth (GET /auth/v1/user), cold bearer each time ──────────────
  {
    id: "A01",
    title: "Auth 401 bad_jwt → 401 credential refusal (no Retry-After)",
    upstream: "auth",
    fault: "http 401",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 1);
      h.inject({
        upstream: "auth",
        spec: http(401, { code: 401, msg: "invalid JWT", error_code: "bad_jwt" }),
      });
      return {
        req: requestFor(u),
        expect: {
          status: 401,
          errorClass: "credential_refused",
          retryAfter: null,
          authCalls: 1,
          postgrestCalls: 0,
          message: "no longer valid",
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "A02",
    title: "Auth 403 (user banned / session gone) → 401",
    upstream: "auth",
    fault: "http 403",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 2);
      h.inject({
        upstream: "auth",
        spec: http(403, { code: 403, msg: "User is banned", error_code: "user_banned" }),
      });
      return {
        req: requestFor(u),
        expect: {
          status: 401,
          errorClass: "credential_refused",
          retryAfter: null,
          authCalls: 1,
          postgrestCalls: 0,
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "A03",
    title: "Auth 400 → 401 (a verdict on the credential)",
    upstream: "auth",
    fault: "http 400",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 3);
      h.inject({
        upstream: "auth",
        spec: http(400, { error: "invalid_grant", error_description: "bad" }),
      });
      return {
        req: requestFor(u),
        expect: { status: 401, errorClass: "credential_refused", authCalls: 1, postgrestCalls: 0 },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "A04",
    title: "Auth 404 → 503 retryable (not a credential verdict)",
    upstream: "auth",
    fault: "http 404",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 4);
      h.inject({ upstream: "auth", spec: raw(404, "not found") });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          retryAfter: "2",
          authCalls: 1,
          postgrestCalls: 0,
          message: GENERIC_503,
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "A05",
    title: "Auth 500 → 503 + Retry-After 2, detail only server-side",
    upstream: "auth",
    fault: "http 500",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 5);
      h.inject({
        upstream: "auth",
        spec: http(500, {
          code: 500,
          msg: "SECRET-DETAIL-a05 db pool exhausted",
          error_code: "unexpected_failure",
        }),
      });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          retryAfter: "2",
          authCalls: 1,
          postgrestCalls: 0,
          noLeak: ["SECRET-DETAIL-a05", "unexpected_failure"],
          loggedDetail: "SECRET-DETAIL-a05",
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "A06",
    title: "Auth 502 HTML gateway page → 503",
    upstream: "auth",
    fault: "http 502 text/html",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 6);
      h.inject({
        upstream: "auth",
        spec: raw(502, "<html><body>502 Bad Gateway</body></html>", {
          "Content-Type": "text/html",
        }),
      });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          retryAfter: "2",
          authCalls: 1,
          postgrestCalls: 0,
          noLeak: ["Bad Gateway", "<html"],
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "A07",
    title: "Auth 503 with Retry-After: 7 → 503 forwarding Retry-After 7",
    upstream: "auth",
    fault: "http 503 Retry-After 7",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 7);
      h.inject({
        upstream: "auth",
        spec: http(503, { msg: "maintenance" }, { "Retry-After": "7" }),
      });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          retryAfter: "7",
          authCalls: 1,
          postgrestCalls: 0,
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "A08",
    title: "Auth 429 (GoTrue rate-limiting the edge) → 503 with upstream Retry-After",
    upstream: "auth",
    fault: "http 429 Retry-After 30",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 8);
      h.inject({
        upstream: "auth",
        spec: http(429, { msg: "over_request_rate_limit" }, { "Retry-After": "30" }),
      });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          retryAfter: "30",
          authCalls: 1,
          postgrestCalls: 0,
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "A09",
    title: "Auth 200 with non-JSON body → 503 (malformed is an outage, not a verdict)",
    upstream: "auth",
    fault: "http 200 text/html",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 9);
      h.inject({
        upstream: "auth",
        spec: raw(200, "<html>ok</html>", { "Content-Type": "text/html" }),
      });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          retryAfter: "2",
          authCalls: 1,
          postgrestCalls: 0,
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "A10",
    title: "Auth 200 `{}` (no id) → 503",
    upstream: "auth",
    fault: "http 200 {}",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 10);
      h.inject({ upstream: "auth", spec: http(200, {}) });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          retryAfter: "2",
          authCalls: 1,
          postgrestCalls: 0,
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "A11",
    title: "Auth 200 `[]` → 503",
    upstream: "auth",
    fault: "http 200 []",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 11);
      h.inject({ upstream: "auth", spec: http(200, []) });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          authCalls: 1,
          postgrestCalls: 0,
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "A12",
    title: "Auth 200 `{id: 123}` (wrong type) → 503",
    upstream: "auth",
    fault: "http 200 id:number",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 12);
      h.inject({
        upstream: "auth",
        spec: http(200, { id: 123, app_metadata: { provider: "google" } }),
      });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          authCalls: 1,
          postgrestCalls: 0,
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "A13",
    title: "Auth 200 for an email-provider user → 401 (not a Google/Apple account)",
    upstream: "auth",
    fault: "http 200 provider=email",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 13);
      h.inject({
        upstream: "auth",
        spec: http(200, {
          id: u.id,
          email: u.email,
          app_metadata: { provider: "email", providers: ["email"] },
        }),
      });
      return {
        req: requestFor(u),
        expect: {
          status: 401,
          errorClass: "credential_refused",
          authCalls: 1,
          postgrestCalls: 0,
          message: "Google or Apple",
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "A14",
    title: "Auth 200 with app_metadata missing → 401",
    upstream: "auth",
    fault: "http 200 no app_metadata",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 14);
      h.inject({ upstream: "auth", spec: http(200, { id: u.id, email: u.email }) });
      return {
        req: requestFor(u),
        expect: { status: 401, errorClass: "credential_refused", authCalls: 1, postgrestCalls: 0 },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "A15",
    title: `Auth hangs past the deadline (${AUTH_DEADLINE_MS}ms) → 503 Retry-After 2 within deadline+250ms`,
    upstream: "auth",
    fault: "hang > deadline",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 15);
      h.inject({ upstream: "auth", spec: { kind: "hang" } });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          retryAfter: "2",
          authCalls: 1,
          postgrestCalls: 0,
          minLatencyMs: AUTH_DEADLINE_MS - 5,
          maxLatencyMs: AUTH_DEADLINE_MS + 250,
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "A16",
    title: "Auth socket reset once, then healthy → 200 after one backoff (2 auth calls)",
    upstream: "auth",
    fault: "network ×1",
    run: async (h, prng) => {
      const ledger = seededLedger(prng, "placeholder");
      const u = await newUser(h, prng, 16);
      h.ledgers.set(
        u.id,
        ledger.map((r) => ({ ...r, user_id: u.id })),
      );
      h.inject({ upstream: "auth", spec: { kind: "network" } });
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 2,
          postgrestCalls: 1,
          minLatencyMs: 95,
          oracleOf: h.ledgers.get(u.id),
        },
      };
    },
  },
  {
    id: "A17",
    title: "Auth socket reset on every attempt → 503 after bounded retries inside the deadline",
    upstream: "auth",
    fault: "network ×∞",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 17);
      h.inject({ upstream: "auth", spec: { kind: "network" }, times: 50 });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          retryAfter: "2",
          authCalls: [1, 6],
          postgrestCalls: 0,
          maxLatencyMs: AUTH_DEADLINE_MS + 250,
        },
        recover: () => {
          h.clearFaults();
          return Promise.resolve(requestFor(u));
        },
      };
    },
  },
  {
    id: "A18",
    title: `Auth socket reset twice under a ${AUTH_DEADLINE_MS}ms deadline → 503 after 2 attempts (the 200ms backoff would overrun the deadline)`,
    upstream: "auth",
    fault: "network ×2, deadline 300ms",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 18);
      h.inject({ upstream: "auth", spec: { kind: "network" }, times: 2 });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          retryAfter: "2",
          authCalls: 2,
          postgrestCalls: 0,
          minLatencyMs: 95,
          maxLatencyMs: AUTH_DEADLINE_MS + 250,
        },
        recover: () => {
          h.clearFaults();
          return Promise.resolve(requestFor(u));
        },
      };
    },
  },
  {
    id: "A29",
    title:
      "Auth socket reset twice under a 1000ms deadline → 200 after 3 attempts (100+200ms backoff)",
    upstream: "auth",
    fault: "network ×2, deadline 1000ms",
    deadlineMs: 1000,
    run: async (h, prng) => {
      const u = await newUser(h, prng, 29);
      h.inject({ upstream: "auth", spec: { kind: "network" }, times: 2 });
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 3,
          postgrestCalls: 1,
          minLatencyMs: 290,
          maxLatencyMs: 900,
          oracleOf: h.ledgers.get(u.id),
        },
      };
    },
  },
  {
    id: "A30",
    title:
      "Auth socket reset ×5 under a 6000ms (default) deadline → 503 after 5 attempts, ≈1.5s (bounded backoff 100+200+400+800)",
    upstream: "auth",
    fault: "network ×5, deadline 6000ms",
    deadlineMs: 6000,
    fullOnly: true,
    run: async (h, prng) => {
      const u = await newUser(h, prng, 30);
      h.inject({ upstream: "auth", spec: { kind: "network" }, times: 50 });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          retryAfter: "2",
          authCalls: 6,
          postgrestCalls: 0,
          minLatencyMs: 1490,
          maxLatencyMs: 3500,
        },
        recover: () => {
          h.clearFaults();
          return Promise.resolve(requestFor(u));
        },
      };
    },
  },
  {
    id: "A19",
    title: "Auth slow (150ms) but inside the deadline → 200",
    upstream: "auth",
    fault: "slow 150ms",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 19);
      h.inject({ upstream: "auth", spec: { kind: "slow", ms: 150 } });
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 1,
          postgrestCalls: 1,
          minLatencyMs: 145,
          oracleOf: h.ledgers.get(u.id),
        },
      };
    },
  },
  {
    id: "A20",
    title:
      "Auth answers after the deadline fired → the late answer is not used (503, no PostgREST call)",
    upstream: "auth",
    fault: "hang then 200 after deadline",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 20);
      h.inject({
        upstream: "auth",
        spec: { kind: "hang", resolveAfterMs: AUTH_DEADLINE_MS + 400, then: { kind: "pass" } },
      });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          authCalls: 1,
          postgrestCalls: 0,
          maxLatencyMs: AUTH_DEADLINE_MS + 250,
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "A21",
    title:
      "Auth healthy after a 503: recovered bearer is cached (second healthy request makes 0 auth calls)",
    upstream: "auth",
    fault: "http 503 then healthy",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 21);
      h.inject({ upstream: "auth", spec: http(503, { msg: "down" }) });
      const first = await h.request(requestFor(u));
      assertEquals(first.response.status, 503);
      await first.response.body?.cancel();
      const second = await h.request(requestFor(u));
      assertEquals(second.response.status, 200);
      await second.response.body?.cancel();
      assertEquals(countBy(second.calls, "auth"), 1, "recovery re-verifies once");
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 0,
          postgrestCalls: 1,
          oracleOf: h.ledgers.get(u.id),
        },
      };
    },
  },
  {
    id: "A22",
    title: "A refusal is never cached: 401 then healthy Auth → 200 with a fresh verification",
    upstream: "auth",
    fault: "http 401 then healthy",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 22);
      h.inject({ upstream: "auth", spec: http(401, { msg: "bad", error_code: "bad_jwt" }) });
      const first = await h.request(requestFor(u));
      assertEquals(first.response.status, 401);
      await first.response.body?.cancel();
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 1,
          postgrestCalls: 1,
          oracleOf: h.ledgers.get(u.id),
        },
      };
    },
  },
  {
    id: "A23",
    title: "Auth 200 with a non-string email → 200 (email is optional)",
    upstream: "auth",
    fault: "http 200 email:number",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 23);
      h.inject({
        upstream: "auth",
        spec: http(200, { id: u.id, email: 42, app_metadata: { provider: u.provider } }),
      });
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 1,
          postgrestCalls: 1,
          oracleOf: h.ledgers.get(u.id),
        },
      };
    },
  },
  {
    id: "A24",
    title: "Expired session bearer → 401 with ZERO upstream calls",
    upstream: "route",
    fault: "bearer exp in the past",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 24);
      const expired = fakeJwt({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: u.id,
        session_id: u.sessionId,
        exp: Math.floor(Date.now() / 1000) - 5,
      });
      return {
        req: rawRequest(expired, u.ip),
        expect: {
          status: 401,
          errorClass: "credential_refused",
          authCalls: 0,
          postgrestCalls: 0,
          message: "expired",
        },
      };
    },
  },
  {
    id: "A25",
    title: "Bearer from an unknown issuer → 401, zero upstream calls",
    upstream: "route",
    fault: "iss=https://evil.example",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 25);
      const foreign = fakeJwt({
        iss: "https://evil.example/auth/v2",
        sub: u.id,
        exp: Math.floor(Date.now() / 1000) + 600,
      });
      return {
        req: rawRequest(foreign, u.ip),
        expect: { status: 401, errorClass: "credential_refused", authCalls: 0, postgrestCalls: 0 },
      };
    },
  },
  {
    id: "A26",
    title: "Missing bearer → 401, zero upstream calls",
    upstream: "route",
    fault: "no Authorization header",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 26);
      return {
        req: rawRequest(null, u.ip),
        expect: {
          status: 401,
          errorClass: "credential_refused",
          authCalls: 0,
          postgrestCalls: 0,
          message: "Missing bearer",
        },
      };
    },
  },
  {
    id: "A27",
    title: "Garbage bearer (not a JWT) → 401, zero upstream calls",
    upstream: "route",
    fault: "Authorization: Bearer not.a.jwt",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 27);
      return {
        req: rawRequest("not.a.jwt", u.ip),
        expect: { status: 401, errorClass: "credential_refused", authCalls: 0, postgrestCalls: 0 },
      };
    },
  },
  {
    id: "A28",
    title:
      "30 refused bearers from one IP trip the auth-failure budget: the 31st is 429 before Auth is called",
    upstream: "route",
    fault: "credential-probing storm",
    run: async (h, prng) => {
      const ip = `198.51.100.${prng.int(1, 254)}`;
      for (let i = 0; i < 30; i += 1) {
        const ghost = seededUser(prng, 1000 + i); // never registered → Auth refuses it
        const { response, calls } = await h.request(rawRequest(ghost.accessToken, ip));
        assertEquals(response.status, 401, `probe ${i + 1}`);
        await response.body?.cancel();
        assertEquals(countBy(calls, "auth"), 1);
      }
      const legit = await newUser(h, prng, 28);
      legit.ip = ip;
      return {
        req: requestFor(legit),
        expect: {
          status: 429,
          errorClass: "rate_limited",
          retryAfter: "any",
          authCalls: 0,
          postgrestCalls: 0,
        },
        recover: () => {
          // Another IP for the same bearer is unaffected.
          legit.ip = `198.51.101.${prng.int(1, 254)}`;
          return Promise.resolve(requestFor(legit));
        },
      };
    },
  },

  // ── PostgREST (GET /rest/v1/consent_records), bearer already cached ───────
  {
    id: "D01",
    title: "PostgREST 500 → 503 generic (server detail only in the log), no auth round trip",
    upstream: "postgrest",
    fault: "http 500",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 101);
      await warm(h, u);
      h.inject({
        upstream: "postgrest",
        spec: http(500, {
          code: "XX000",
          message: "SECRET-DETAIL-d01 internal error",
          details: null,
          hint: null,
        }),
      });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          authCalls: 0,
          postgrestCalls: 1,
          message: "Consent status is temporarily unavailable",
          noLeak: ["SECRET-DETAIL-d01", "XX000"],
          loggedDetail: "SECRET-DETAIL-d01",
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "D02",
    title:
      "PostgREST 503 once → supabase-js retries the GET after 1s and the request succeeds (200, 2 DB round trips)",
    upstream: "postgrest",
    fault: "http 503 ×1",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 102);
      await warm(h, u);
      h.inject({ upstream: "postgrest", spec: http(503, { message: "service unavailable" }) });
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 0,
          postgrestCalls: 2,
          minLatencyMs: 990,
          maxLatencyMs: 1600,
          oracleOf: h.ledgers.get(u.id),
        },
      };
    },
  },
  {
    id: "D23",
    title:
      "PostgREST 503 ×4 (Retry-After: 0) → 503 only after FOUR DB round trips (library retry, no route budget)",
    upstream: "postgrest",
    fault: "http 503 ×4 Retry-After 0",
    finding: "F-D16-postgrest-retry-no-deadline",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 123);
      await warm(h, u);
      h.inject({
        upstream: "postgrest",
        spec: http(503, { message: "service unavailable" }, { "Retry-After": "0" }),
        times: 4,
      });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          authCalls: 0,
          maxPostgrestCalls: 3,
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "D24",
    title:
      "PostgREST 503 with Retry-After: 2 → the function sleeps the full 2s inside the request before retrying",
    upstream: "postgrest",
    fault: "http 503 ×1 Retry-After 2",
    finding: "F-D16-postgrest-retry-no-deadline",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 124);
      await warm(h, u);
      h.inject({
        upstream: "postgrest",
        spec: http(503, { message: "service unavailable" }, { "Retry-After": "2" }),
      });
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 0,
          postgrestCalls: 2,
          minLatencyMs: 1990,
          maxLatencyMs: 1500,
          oracleOf: h.ledgers.get(u.id),
        },
      };
    },
  },
  {
    id: "D25",
    title:
      "PostgREST 503 persistent (no Retry-After) → 503 after 4 round trips and ≈7s (1+2+4s backoff)",
    upstream: "postgrest",
    fault: "http 503 ×4",
    finding: "F-D16-postgrest-retry-no-deadline",
    fullOnly: true,
    run: async (h, prng) => {
      const u = await newUser(h, prng, 125);
      await warm(h, u);
      h.inject({
        upstream: "postgrest",
        spec: http(503, { message: "service unavailable" }),
        times: 4,
      });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          authCalls: 0,
          maxPostgrestCalls: 3,
          maxLatencyMs: 3000,
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "D26",
    title: "PostgREST socket reset persistent → 503 after 4 round trips and ≈7s",
    upstream: "postgrest",
    fault: "network ×4",
    finding: "F-D16-postgrest-retry-no-deadline",
    fullOnly: true,
    run: async (h, prng) => {
      const u = await newUser(h, prng, 126);
      await warm(h, u);
      h.inject({
        upstream: "postgrest",
        spec: { kind: "network", message: "SECRET-DETAIL-d26 reset" },
        times: 4,
      });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          authCalls: 0,
          maxPostgrestCalls: 3,
          maxLatencyMs: 3000,
          noLeak: ["SECRET-DETAIL-d26"],
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "D03",
    title:
      "PostgREST 401 PGRST301 (JWT refused at the DB) → 503 'try again' although a retry cannot succeed until the bearer rotates",
    upstream: "postgrest",
    fault: "http 401 PGRST301",
    finding: "F-D03-postgrest-401-classified-retryable",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 103);
      await warm(h, u);
      h.inject({
        upstream: "postgrest",
        spec: http(401, { code: "PGRST301", message: "JWT expired", details: null, hint: null }),
      });
      return {
        req: requestFor(u),
        expect: { status: 401, errorClass: "credential_refused", authCalls: 0, postgrestCalls: 1 },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "D04",
    title: "PostgREST 403 42501 (permission denied) → 503 generic",
    upstream: "postgrest",
    fault: "http 403 42501",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 104);
      await warm(h, u);
      h.inject({
        upstream: "postgrest",
        spec: http(403, { code: "42501", message: "permission denied for table consent_records" }),
      });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          authCalls: 0,
          postgrestCalls: 1,
          noLeak: ["42501", "permission denied"],
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "D05",
    title: "PostgREST 404 PGRST205 (relation missing) → 503",
    upstream: "postgrest",
    fault: "http 404 PGRST205",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 105);
      await warm(h, u);
      h.inject({
        upstream: "postgrest",
        spec: http(404, { code: "PGRST205", message: "Could not find the table" }),
      });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          authCalls: 0,
          postgrestCalls: 1,
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "D06",
    title: "PostgREST 429 → 503",
    upstream: "postgrest",
    fault: "http 429",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 106);
      await warm(h, u);
      h.inject({
        upstream: "postgrest",
        spec: http(429, { message: "too many connections" }, { "Retry-After": "5" }),
      });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          authCalls: 0,
          postgrestCalls: 1,
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "D07",
    title: "PostgREST 502 HTML → 503",
    upstream: "postgrest",
    fault: "http 502 text/html",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 107);
      await warm(h, u);
      h.inject({
        upstream: "postgrest",
        spec: raw(502, "<html>502</html>", { "Content-Type": "text/html" }),
      });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          authCalls: 0,
          postgrestCalls: 1,
          noLeak: ["<html"],
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "D08",
    title: "PostgREST 200 with a non-JSON body → 503",
    upstream: "postgrest",
    fault: "http 200 text",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 108);
      await warm(h, u);
      h.inject({ upstream: "postgrest", spec: raw(200, "this is not json") });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          authCalls: 0,
          postgrestCalls: 1,
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "D09",
    title:
      "PostgREST 200 with an object body instead of rows → generic 500 (unhandled), still recoverable",
    upstream: "postgrest",
    fault: "http 200 {}",
    finding: "F-D09-postgrest-object-body-500",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 109);
      await warm(h, u);
      h.inject({
        upstream: "postgrest",
        spec: http(200, { scope: "video_analysis", action: "grant" }),
      });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          authCalls: 0,
          postgrestCalls: 1,
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "D10",
    title: "PostgREST 200 `null` → 200, every scope inactive",
    upstream: "postgrest",
    fault: "http 200 null",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 110);
      await warm(h, u);
      h.inject({ upstream: "postgrest", spec: raw(200, "null") });
      return {
        req: requestFor(u),
        expect: { status: 200, errorClass: "ok", authCalls: 0, postgrestCalls: 1, oracleOf: [] },
      };
    },
  },
  {
    id: "D11",
    title: "PostgREST rows with unknown scopes → ignored, the three real scopes still reported",
    upstream: "postgrest",
    fault: "http 200 scope=marketing",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 111, []);
      await warm(h, u);
      const rows = [
        {
          scope: "marketing",
          action: "grant",
          consent_version: "x",
          created_at: "2026-02-01T00:00:00+00:00",
        },
      ];
      h.inject({ upstream: "postgrest", spec: http(200, rows) });
      return {
        req: requestFor(u),
        expect: { status: 200, errorClass: "ok", authCalls: 0, postgrestCalls: 1, oracleOf: [] },
      };
    },
  },
  {
    id: "D12",
    title: "PostgREST row with an unknown action → reported as withdrawn/inactive (fail-closed)",
    upstream: "postgrest",
    fault: "http 200 action=revoke",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 112, []);
      await warm(h, u);
      h.inject({
        upstream: "postgrest",
        spec: http(200, [
          {
            scope: "video_analysis",
            action: "revoke",
            consent_version: "2026-01",
            created_at: "2026-02-01T00:00:00+00:00",
          },
        ]),
      });
      return {
        req: requestFor(u),
        expect: { status: 200, errorClass: "ok", authCalls: 0, postgrestCalls: 1 },
      };
    },
  },
  {
    id: "D13",
    title: "PostgREST rows missing columns → 200 with nulls, never a crash",
    upstream: "postgrest",
    fault: "http 200 partial rows",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 113, []);
      await warm(h, u);
      h.inject({
        upstream: "postgrest",
        spec: http(200, [
          { scope: "model_training", action: "grant" },
          { scope: "evaluation_telemetry" },
        ]),
      });
      return {
        req: requestFor(u),
        expect: { status: 200, errorClass: "ok", authCalls: 0, postgrestCalls: 1 },
      };
    },
  },
  {
    id: "D14",
    title: "PostgREST 5,000-row ledger → 200 folded correctly under 250ms",
    upstream: "postgrest",
    fault: "http 200 ×5000 rows",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 114, []);
      const big: LedgerRow[] = [];
      for (let i = 0; i < 5000; i += 1) big.push(...seededLedger(prng, u.id, 1));
      const ledger = big.slice(0, 5000).map((r) => ({ ...r, user_id: u.id }));
      h.ledgers.set(u.id, ledger);
      await warm(h, u);
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 0,
          postgrestCalls: 1,
          maxLatencyMs: 250,
          oracleOf: ledger,
        },
      };
    },
  },
  {
    id: "D15",
    title: "PostgREST socket reset once → retried after 1s, 200 (2 DB round trips)",
    upstream: "postgrest",
    fault: "network ×1",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 115);
      await warm(h, u);
      h.inject({
        upstream: "postgrest",
        spec: { kind: "network", message: "SECRET-DETAIL-d15 connection reset" },
      });
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 0,
          postgrestCalls: 2,
          minLatencyMs: 990,
          maxLatencyMs: 1600,
          noLeak: ["SECRET-DETAIL-d15"],
          oracleOf: h.ledgers.get(u.id),
        },
      };
    },
  },
  {
    id: "D16",
    title:
      "PostgREST stalls 2.5s → the request waits the full stall (no DB deadline; Auth has one)",
    upstream: "postgrest",
    fault: "hang 2500ms then 200",
    finding: "F-D16-postgrest-retry-no-deadline",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 116);
      await warm(h, u);
      h.inject({
        upstream: "postgrest",
        spec: { kind: "hang", resolveAfterMs: 2500, then: { kind: "pass" } },
      });
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 0,
          postgrestCalls: 1,
          maxLatencyMs: 2000,
          oracleOf: h.ledgers.get(u.id),
        },
      };
    },
  },
  {
    id: "D17",
    title: "PostgREST slow 200ms → 200 (latency ≥ 200ms, 1 round trip)",
    upstream: "postgrest",
    fault: "slow 200ms",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 117);
      await warm(h, u);
      h.inject({ upstream: "postgrest", spec: { kind: "slow", ms: 200 } });
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 0,
          postgrestCalls: 1,
          minLatencyMs: 195,
          oracleOf: h.ledgers.get(u.id),
        },
      };
    },
  },
  {
    id: "D18",
    title:
      "PostgREST 500 twice then healthy → each failure is 503 and the third request is 200 (auth stays cached)",
    upstream: "postgrest",
    fault: "http 500 ×2",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 118);
      await warm(h, u);
      h.inject({ upstream: "postgrest", spec: http(500, { message: "boom" }), times: 2 });
      for (let i = 0; i < 2; i += 1) {
        const { response, calls } = await h.request(requestFor(u));
        assertEquals(response.status, 503, `failure ${i + 1}`);
        await response.body?.cancel();
        assertEquals(countBy(calls, "auth"), 0);
      }
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 0,
          postgrestCalls: 1,
          oracleOf: h.ledgers.get(u.id),
        },
      };
    },
  },
  {
    id: "D19",
    title:
      "PostgREST 200 with rows for a DIFFERENT user (RLS assumed broken) → the route trusts the DB filter",
    upstream: "postgrest",
    fault: "http 200 foreign rows",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 119, []);
      await warm(h, u);
      const other = seededUser(prng, 1119);
      const foreign = seededLedger(prng, other.id, 6);
      h.inject({
        upstream: "postgrest",
        spec: http(
          200,
          foreign.map(({ scope, action, consent_version, created_at }) => ({
            scope,
            action,
            consent_version,
            created_at,
          })),
        ),
      });
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 0,
          postgrestCalls: 1,
          oracleOf: foreign,
        },
      };
    },
  },
  {
    id: "D20",
    title:
      "PostgREST 200 rows delivered out of order → the fold trusts the DB order (positional latest wins)",
    upstream: "postgrest",
    fault: "http 200 unsorted",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 120, []);
      await warm(h, u);
      const rows = [
        {
          scope: "video_analysis",
          action: "withdraw",
          consent_version: "2026-01",
          created_at: "2026-03-01T00:00:00+00:00",
        },
        {
          scope: "video_analysis",
          action: "grant",
          consent_version: "2026-01",
          created_at: "2026-01-01T00:00:00+00:00",
        },
      ];
      h.inject({ upstream: "postgrest", spec: http(200, rows) });
      return {
        req: requestFor(u),
        expect: { status: 200, errorClass: "ok", authCalls: 0, postgrestCalls: 1 },
      };
    },
  },
  {
    id: "D21",
    title: "PostgREST 406 (PGRST116) → 503",
    upstream: "postgrest",
    fault: "http 406",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 121);
      await warm(h, u);
      h.inject({ upstream: "postgrest", spec: http(406, { code: "PGRST116", message: "0 rows" }) });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          authCalls: 0,
          postgrestCalls: 1,
        },
        recover: () => Promise.resolve(requestFor(u)),
      };
    },
  },
  {
    id: "D22",
    title: "PostgREST 200 with an empty body → 200, every scope inactive",
    upstream: "postgrest",
    fault: "http 200 ''",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 122);
      await warm(h, u);
      h.inject({ upstream: "postgrest", spec: raw(200, "") });
      return {
        req: requestFor(u),
        expect: { status: 200, errorClass: "ok", authCalls: 0, postgrestCalls: 1, oracleOf: [] },
      };
    },
  },

  // ── RevenueCat — this route must never touch it ───────────────────────────
  {
    id: "C01",
    title: "RevenueCat 500 queued → route unaffected (0 RevenueCat calls)",
    upstream: "revenuecat",
    fault: "http 500 (never consumed)",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 201);
      h.inject({ upstream: "revenuecat", spec: http(500, { message: "rc down" }), times: 5 });
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 1,
          postgrestCalls: 1,
          revenuecatCalls: 0,
          oracleOf: h.ledgers.get(u.id),
        },
      };
    },
  },
  {
    id: "C02",
    title: "RevenueCat hang queued → route unaffected",
    upstream: "revenuecat",
    fault: "hang (never consumed)",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 202);
      h.inject({ upstream: "revenuecat", spec: { kind: "hang" }, times: 5 });
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 1,
          postgrestCalls: 1,
          revenuecatCalls: 0,
          maxLatencyMs: 200,
        },
      };
    },
  },
  {
    id: "C03",
    title: "RevenueCat malformed queued → route unaffected",
    upstream: "revenuecat",
    fault: "http 200 garbage (never consumed)",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 203);
      h.inject({ upstream: "revenuecat", spec: raw(200, "garbage"), times: 5 });
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 1,
          postgrestCalls: 1,
          revenuecatCalls: 0,
        },
      };
    },
  },

  // ── Combined ──────────────────────────────────────────────────────────────
  {
    id: "X01",
    title:
      "Cold bearer + PostgREST 500 → 503, and the verified bearer is cached despite the DB failure",
    upstream: "mixed",
    fault: "auth ok, postgrest 500",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 301);
      h.inject({ upstream: "postgrest", spec: http(500, { message: "boom" }) });
      const first = await h.request(requestFor(u));
      assertEquals(first.response.status, 503);
      await first.response.body?.cancel();
      assertEquals(countBy(first.calls, "auth"), 1);
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 0,
          postgrestCalls: 1,
          oracleOf: h.ledgers.get(u.id),
        },
      };
    },
  },
  {
    id: "X02",
    title: "Auth hang AND PostgREST hang → bounded by the Auth deadline alone (DB never reached)",
    upstream: "mixed",
    fault: "auth hang, postgrest hang",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 302);
      h.inject({ upstream: "auth", spec: { kind: "hang" } });
      h.inject({
        upstream: "postgrest",
        spec: { kind: "hang", resolveAfterMs: 1500, then: { kind: "pass" } },
      });
      return {
        req: requestFor(u),
        expect: {
          status: 503,
          errorClass: "retryable_unavailable",
          authCalls: 1,
          postgrestCalls: 0,
          maxLatencyMs: AUTH_DEADLINE_MS + 250,
        },
        recover: () => {
          h.clearFaults();
          return Promise.resolve(requestFor(u));
        },
      };
    },
  },
  {
    id: "X03",
    title:
      "Auth 503 then PostgREST 500 then both healthy → 503, 503, 200 (each fault classified on its own)",
    upstream: "mixed",
    fault: "sequence",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 303);
      h.inject({ upstream: "auth", spec: http(503, { msg: "down" }) });
      const a = await h.request(requestFor(u));
      assertEquals(a.response.status, 503);
      assertEquals(a.response.headers.get("Retry-After"), "2");
      await a.response.body?.cancel();
      h.inject({ upstream: "postgrest", spec: http(500, { message: "boom" }) });
      const b = await h.request(requestFor(u));
      assertEquals(b.response.status, 503);
      await b.response.body?.cancel();
      assertEquals(countBy(b.calls, "auth"), 1, "the bearer is verified once Auth is back");
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 0,
          postgrestCalls: 1,
          oracleOf: h.ledgers.get(u.id),
        },
      };
    },
  },
  {
    id: "X04",
    title: "Same bearer, 5 concurrent cold requests during an Auth 500 → all 503, none 401",
    upstream: "mixed",
    fault: "auth 500 ×5 concurrent",
    run: async (h, prng) => {
      const u = await newUser(h, prng, 304);
      h.inject({ upstream: "auth", spec: http(500, { msg: "down" }), times: 5 });
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => h.handler(requestFor(u))),
      );
      for (const r of responses) {
        assertEquals(r.status, 503);
        await r.body?.cancel();
      }
      return {
        req: requestFor(u),
        expect: {
          status: 200,
          errorClass: "ok",
          authCalls: 1,
          postgrestCalls: 1,
          oracleOf: h.ledgers.get(u.id),
        },
      };
    },
  },
];

Deno.test(
  "stress consent-status: fault matrix (Auth / PostgREST / RevenueCat / route)",
  async (t) => {
    const h = await loadStressHarness();
    Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(AUTH_DEADLINE_MS));
    const outcomes: CaseOutcome[] = [];
    const invariants: Invariant[] = [];
    try {
      for (const c of CASES) {
        if (STRESS_CASE.size > 0 ? !STRESS_CASE.has(c.id) : c.fullOnly && STRESS_ITER < 1000)
          continue;
        await t.step(`${c.id} ${c.title}`, async () => {
          h.clearFaults();
          Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(c.deadlineMs ?? AUTH_DEADLINE_MS));
          const seed = (STRESS_SEED ^ (c.id.charCodeAt(0) << 16) ^ Number(c.id.slice(1))) >>> 0;
          const prng = new Prng(seed);
          const errorsBefore = h.errorLog.length;
          const { req, expect, recover } = await c.run(h, prng);
          const { response, calls, latencyMs } = await h.request(req);
          const retryAfter = response.headers.get("Retry-After");
          const bodyText = await response.text();
          let code: string | null = null;
          let message: string | null = null;
          let parsedBody: unknown = null;
          try {
            parsedBody = JSON.parse(bodyText);
            const err = (parsedBody as { error?: { code?: string; message?: string } })?.error;
            code = typeof err?.code === "string" ? err.code : null;
            message = typeof err?.message === "string" ? err.message : null;
          } catch {
            // non-JSON body is itself a failure below
          }
          const problems: string[] = [];
          if (response.status !== expect.status)
            problems.push(`status ${response.status} ≠ ${expect.status}`);
          const errorClass = classify(response.status, code, retryAfter);
          if (errorClass !== expect.errorClass)
            problems.push(`class ${errorClass} ≠ ${expect.errorClass}`);
          if (expect.retryAfter === null && retryAfter !== null)
            problems.push(`unexpected Retry-After ${retryAfter}`);
          if (
            typeof expect.retryAfter === "string" &&
            expect.retryAfter !== "any" &&
            retryAfter !== expect.retryAfter
          ) {
            problems.push(`Retry-After ${retryAfter} ≠ ${expect.retryAfter}`);
          }
          if (expect.retryAfter === "any" && retryAfter === null)
            problems.push("Retry-After missing");
          const authCalls = countBy(calls, "auth");
          const postgrestCalls = countBy(calls, "postgrest");
          const rcCalls = countBy(calls, "revenuecat");
          if (expect.authCalls !== undefined && !inRange(authCalls, expect.authCalls))
            problems.push(`auth calls ${authCalls} ≠ ${JSON.stringify(expect.authCalls)}`);
          if (expect.postgrestCalls !== undefined && postgrestCalls !== expect.postgrestCalls)
            problems.push(`postgrest calls ${postgrestCalls} ≠ ${expect.postgrestCalls}`);
          if (expect.maxPostgrestCalls !== undefined && postgrestCalls > expect.maxPostgrestCalls)
            problems.push(`postgrest calls ${postgrestCalls} > ${expect.maxPostgrestCalls}`);
          if (expect.revenuecatCalls !== undefined && rcCalls !== expect.revenuecatCalls)
            problems.push(`revenuecat calls ${rcCalls}`);
          if (expect.minLatencyMs !== undefined && latencyMs < expect.minLatencyMs)
            problems.push(`latency ${latencyMs.toFixed(0)}ms < ${expect.minLatencyMs}`);
          if (expect.maxLatencyMs !== undefined && latencyMs > expect.maxLatencyMs)
            problems.push(`latency ${latencyMs.toFixed(0)}ms > ${expect.maxLatencyMs}`);
          for (const leak of expect.noLeak ?? [])
            if (bodyText.includes(leak)) problems.push(`body leaks "${leak}"`);
          if (expect.message && !(message ?? "").includes(expect.message))
            problems.push(`message "${message}" lacks "${expect.message}"`);
          if (expect.oracleOf) {
            const want = JSON.stringify(oracleFold(expect.oracleOf));
            if (JSON.stringify(parsedBody) !== want)
              problems.push(`body ≠ oracle fold: ${bodyText.slice(0, 200)}`);
          }
          if (
            expect.loggedDetail &&
            !h.errorLog.slice(errorsBefore).some((line) => line.includes(expect.loggedDetail!))
          ) {
            problems.push(`server log lacks "${expect.loggedDetail}"`);
          }
          if (response.status >= 400) {
            if (response.headers.get("Cache-Control") !== "no-store")
              problems.push("error lacks Cache-Control: no-store");
            if (!response.headers.get("x-request-id")) problems.push("error lacks x-request-id");
            if (message === null) problems.push("error body has no error.message");
          }
          let recoverable: boolean | null = null;
          if (recover) {
            const follow = await h.request(await recover());
            const followBody = await follow.response.text();
            recoverable = follow.response.status === 200 && followBody.includes('"scopes"');
            if (!recoverable)
              problems.push(
                `recovery request → ${follow.response.status} ${followBody.slice(0, 120)}`,
              );
          }
          const outcome: CaseOutcome = {
            id: c.id,
            seed,
            title: c.title,
            upstream: c.upstream,
            fault: c.fault,
            status: response.status,
            code,
            message,
            retryAfter,
            latencyMs: Math.round(latencyMs * 10) / 10,
            supabaseRoundTrips: authCalls + postgrestCalls,
            authCalls,
            postgrestCalls,
            redisCalls: countBy(calls, "redis"),
            revenuecatCalls: rcCalls,
            errorClass,
            recoverable,
            expected: `${expect.status} ${expect.errorClass}${expect.retryAfter ? ` Retry-After=${expect.retryAfter}` : ""}`,
            verdict: problems.length === 0 ? "HELD" : "BROKEN",
            detail: problems.join("; "),
            replay: replayCommand(FILE, "fault matrix", STRESS_SEED, c.id),
          };
          outcomes.push(outcome);
          invariants.push({
            name: `${c.id} ${c.title}`,
            holds: problems.length === 0,
            detail: problems.join("; ") || "as expected",
            finding: c.finding,
          });
          if (problems.length > 0 && !c.finding) {
            throw new Error(`${c.id}: ${problems.join("; ")}`);
          }
        });
      }
    } finally {
      Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
      const path = await writeJson("fault_matrix", {
        route: "GET /v1/me/consent/status",
        boot: "L1 only (no Upstash)",
        seed: STRESS_SEED,
        authDeadlineMs: AUTH_DEADLINE_MS,
        cases: outcomes.length,
        held: outcomes.filter((o) => o.verdict === "HELD").length,
        broken: outcomes.filter((o) => o.verdict === "BROKEN").map((o) => o.id),
        outcomes,
        serverErrorLog: h.errorLog,
      });
      console.log(`[stress] fault matrix: ${outcomes.length} cases → ${path}`);
    }
    if (STRESS_CASE.size === 0)
      assert(outcomes.length >= 40, `≥40 fault cases executed (got ${outcomes.length})`);
    assertInvariants(invariants, "fault matrix");
  },
);

// ─── load ────────────────────────────────────────────────────────────────────

interface LoadRow {
  i: number;
  seed: number;
  user: number;
  fault: string;
  status: number;
  latencyMs: number;
  auth: number;
  postgrest: number;
  supabase: number;
  ok: boolean;
  detail?: string;
}

Deno.test(
  `stress consent-status: load — ${STRESS_ITER} seeded requests, p50/p95 latency, Supabase round trips per request`,
  async () => {
    const h = await loadStressHarness();
    const prng = new Prng((STRESS_SEED ^ 0x10ad) >>> 0);
    const POPULATION = 50;
    const users: StressUser[] = [];
    for (let i = 0; i < POPULATION; i += 1) {
      const user = seededUser(prng, 5000 + i);
      h.addUser(user, seededLedger(prng, user.id));
      users.push(user);
    }
    const rows: LoadRow[] = [];
    const invariants: Invariant[] = [];
    let expectedFaults = 0;
    for (let i = 0; i < STRESS_ITER; i += 1) {
      const iterSeed = (STRESS_SEED ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
      const p = new Prng(iterSeed);
      const userIndex = p.int(0, POPULATION - 1);
      const user = users[userIndex];
      // Seeded fault mix: 4% DB 500 (final), 2% DB 503 transient (library retry, Retry-After 0),
      // 0.5% DB socket reset (library retry after 1s), 1% Auth 503 (bites only on a cold bearer), 1% DB slow 20ms.
      const roll = p.next();
      let fault = "none";
      if (roll < 0.04) {
        fault = "postgrest 500";
        h.inject({ upstream: "postgrest", spec: http(500, { message: `load ${i}` }) });
      } else if (roll < 0.06) {
        fault = "postgrest 503 transient";
        h.inject({
          upstream: "postgrest",
          spec: http(503, { message: `load ${i}` }, { "Retry-After": "0" }),
        });
      } else if (roll < 0.065) {
        fault = "postgrest network";
        h.inject({ upstream: "postgrest", spec: { kind: "network" } });
      } else if (roll < 0.075) {
        fault = "auth 503";
        h.inject({ upstream: "auth", spec: http(503, { msg: "down" }) });
      } else if (roll < 0.085) {
        fault = "postgrest slow 20ms";
        h.inject({ upstream: "postgrest", spec: { kind: "slow", ms: 20 } });
      }
      // Occasionally the ledger grows (a grant/withdraw landed between reads).
      if (p.chance(0.1)) {
        const ledger = h.ledgers.get(user.id)!;
        const last = ledger[ledger.length - 1];
        const at = new Date(
          (last ? Date.parse(last.created_at) : Date.UTC(2026, 3, 1)) + p.int(0, 60_000),
        ).toISOString();
        ledger.push({
          id: p.uuid(),
          user_id: user.id,
          scope: p.pick(["video_analysis", "model_training", "evaluation_telemetry"]),
          action: p.chance(0.5) ? "grant" : "withdraw",
          consent_version: "2026-05",
          created_at: at,
        });
      }
      const { response, calls, latencyMs } = await h.request(requestFor(user));
      const body = await response.text();
      const auth = countBy(calls, "auth");
      const postgrest = countBy(calls, "postgrest");
      const row: LoadRow = {
        i,
        seed: iterSeed,
        user: userIndex,
        fault,
        status: response.status,
        latencyMs: Math.round(latencyMs * 100) / 100,
        auth,
        postgrest,
        supabase: auth + postgrest,
        ok: true,
      };
      const problems: string[] = [];
      const consumed = calls.some((c) => c.fault !== undefined);
      if (fault === "auth 503" && !consumed) {
        // Warm bearer: the queued Auth fault was not reached; drop it so it cannot bite a later iteration.
        h.clearFaults();
      }
      if (consumed) expectedFaults += 1;
      if (fault === "none" || !consumed) {
        if (response.status !== 200)
          problems.push(`healthy request → ${response.status} ${body.slice(0, 100)}`);
        else if (body !== JSON.stringify(oracleFold(h.ledgers.get(user.id)!)))
          problems.push("body ≠ oracle");
      } else if (fault === "postgrest slow 20ms") {
        if (response.status !== 200) problems.push(`slow DB → ${response.status}`);
        if (latencyMs < 19) problems.push(`slow DB latency ${latencyMs}`);
      } else if (fault === "postgrest 503 transient" || fault === "postgrest network") {
        if (response.status !== 200)
          problems.push(
            `transient ${fault} → ${response.status}, expected 200 after the library retry`,
          );
        else if (body !== JSON.stringify(oracleFold(h.ledgers.get(user.id)!)))
          problems.push("body ≠ oracle");
        if (postgrest !== 2)
          problems.push(`transient ${fault} did ${postgrest} DB round trips, expected 2`);
        if (fault === "postgrest network" && latencyMs < 990)
          problems.push(`network retry latency ${latencyMs}ms < 1s backoff`);
        if (body.includes(`load ${i}`)) problems.push("body leaks upstream detail");
      } else {
        if (response.status !== 503)
          problems.push(`injected ${fault} → ${response.status}, expected 503`);
        if (body.includes(`load ${i}`)) problems.push("body leaks upstream detail");
      }
      if (auth + postgrest > 3)
        problems.push(`request did ${auth + postgrest} Supabase round trips`);
      if (auth > 1) problems.push(`${auth} auth round trips in one request`);
      if (fault === "none" && postgrest !== 1)
        problems.push(`healthy request did ${postgrest} PostgREST round trips`);
      if (problems.length > 0) {
        row.ok = false;
        row.detail = problems.join("; ");
      }
      rows.push(row);
    }
    h.clearFaults();
    const okRows = rows.filter((r) => r.status === 200 && r.fault === "none");
    const lat = okRows.map((r) => r.latencyMs).sort((a, b) => a - b);
    const warmLat = okRows
      .filter((r) => r.auth === 0)
      .map((r) => r.latencyMs)
      .sort((a, b) => a - b);
    const coldLat = okRows
      .filter((r) => r.auth === 1)
      .map((r) => r.latencyMs)
      .sort((a, b) => a - b);
    const failed = rows.filter((r) => !r.ok);
    const summary = {
      route: "GET /v1/me/consent/status",
      seed: STRESS_SEED,
      requests: rows.length,
      population: POPULATION,
      statusHistogram: histogram(rows.map((r) => r.status)),
      faultHistogram: histogram(rows.map((r) => r.fault)),
      injectedFaultsConsumed: expectedFaults,
      latencyMs: {
        healthy: {
          n: lat.length,
          p50: percentile(lat, 50),
          p95: percentile(lat, 95),
          p99: percentile(lat, 99),
          max: lat[lat.length - 1] ?? 0,
        },
        warmBearer: {
          n: warmLat.length,
          p50: percentile(warmLat, 50),
          p95: percentile(warmLat, 95),
        },
        coldBearer: {
          n: coldLat.length,
          p50: percentile(coldLat, 50),
          p95: percentile(coldLat, 95),
        },
      },
      supabaseRoundTrips: {
        perRequestHistogram: histogram(rows.map((r) => r.supabase)),
        perFaultHistogram: Object.fromEntries(
          Object.keys(histogram(rows.map((r) => r.fault))).map((f) => [
            f,
            histogram(rows.filter((r) => r.fault === f).map((r) => r.supabase)),
          ]),
        ),
        max: Math.max(...rows.map((r) => r.supabase)),
        healthyWarmMax: Math.max(
          0,
          ...rows.filter((r) => r.fault === "none" && r.auth === 0).map((r) => r.supabase),
        ),
        healthyColdMax: Math.max(
          0,
          ...rows.filter((r) => r.fault === "none" && r.auth === 1).map((r) => r.supabase),
        ),
        redisCallsTotal: countBy(h.calls, "redis"),
      },
      failed: failed.length,
      failedSeeds: failed.map((r) => ({ i: r.i, seed: r.seed, detail: r.detail })),
      replay: replayCommand(FILE, "load", STRESS_SEED),
      rows,
    };
    const path = await writeJson("load", summary);
    console.log(
      `[stress] load: ${rows.length} req, healthy p50=${summary.latencyMs.healthy.p50}ms p95=${summary.latencyMs.healthy.p95}ms, ` +
        `supabase RT/request max=${summary.supabaseRoundTrips.max} (healthy warm ${summary.supabaseRoundTrips.healthyWarmMax}, healthy cold ${summary.supabaseRoundTrips.healthyColdMax}), failed=${failed.length} → ${path}`,
    );
    invariants.push({
      name: "every iteration matched its expectation (status, oracle body, no detail leak)",
      holds: failed.length === 0,
      detail: failed.length === 0 ? `${rows.length} ok` : JSON.stringify(failed.slice(0, 5)),
    });
    invariants.push({
      name: "no request exceeded 3 Supabase round trips (observed max, faults included)",
      holds: summary.supabaseRoundTrips.max <= 3,
      detail: `max ${summary.supabaseRoundTrips.max}`,
    });
    invariants.push({
      name: "healthy warm bearer costs exactly 1 Supabase round trip",
      holds: summary.supabaseRoundTrips.healthyWarmMax === 1,
      detail: `warm max ${summary.supabaseRoundTrips.healthyWarmMax}`,
    });
    invariants.push({
      name: "healthy cold bearer costs exactly 2 Supabase round trips",
      holds: summary.supabaseRoundTrips.healthyColdMax === 2,
      detail: `cold max ${summary.supabaseRoundTrips.healthyColdMax}`,
    });
    invariants.push({
      name: "healthy p95 in-process latency < 50ms (stubs answer instantly)",
      holds: summary.latencyMs.healthy.p95 < 50,
      detail: `p95 ${summary.latencyMs.healthy.p95}ms`,
    });
    assertInvariants(invariants, "load");
  },
);

Deno.test(
  "stress consent-status: load — 100 concurrent requests across users keep bodies attributed to the right bearer",
  async () => {
    const h = await loadStressHarness();
    const prng = new Prng((STRESS_SEED ^ 0xc0c0) >>> 0);
    const users: StressUser[] = [];
    for (let i = 0; i < 25; i += 1) {
      const user = seededUser(prng, 6000 + i);
      h.addUser(user, seededLedger(prng, user.id));
      users.push(user);
    }
    const before = h.calls.length;
    const picks = Array.from({ length: 100 }, () => users[prng.int(0, users.length - 1)]);
    const t0 = performance.now();
    const responses = await Promise.all(picks.map((u) => h.handler(requestFor(u))));
    const wallMs = performance.now() - t0;
    let mismatched = 0;
    for (let i = 0; i < responses.length; i += 1) {
      const body = await responses[i].text();
      if (
        responses[i].status !== 200 ||
        body !== JSON.stringify(oracleFold(h.ledgers.get(picks[i].id)!))
      )
        mismatched += 1;
    }
    const calls = h.calls.slice(before);
    const auth = countBy(calls, "auth");
    const postgrest = countBy(calls, "postgrest");
    const path = await writeJson("load_concurrent", {
      requests: 100,
      users: 25,
      wallMs: Math.round(wallMs),
      authCalls: auth,
      postgrestCalls: postgrest,
      mismatched,
      seed: STRESS_SEED,
    });
    console.log(
      `[stress] concurrent: 100 req in ${wallMs.toFixed(0)}ms, auth=${auth} postgrest=${postgrest} mismatched=${mismatched} → ${path}`,
    );
    assertEquals(mismatched, 0, "every concurrent response matches its own bearer's ledger");
    assertEquals(postgrest, 100, "one PostgREST read per request");
    assert(auth <= 100 && auth >= 25, `cold verifications bounded by requests (${auth})`);
  },
);

// ─── L1 memory under many distinct users ─────────────────────────────────────

Deno.test(
  `stress consent-status: L1 caches under ${STRESS_USERS} distinct users (heap + auth-cache cap)`,
  async () => {
    const h = await loadStressHarness();
    const prng = new Prng((STRESS_SEED ^ 0x3e3) >>> 0);
    const gc = (globalThis as { gc?: () => void }).gc;
    // The fake upstream's own model (users, tokens, ledgers) is built BEFORE the
    // heap baseline so the delta is the edge module's state (auth cache, rate-limit
    // windows, anything retained per request), not the test's bookkeeping.
    const users: StressUser[] = [];
    for (let i = 0; i < STRESS_USERS; i += 1) {
      const user = seededUser(prng, 10_000 + i);
      h.addUser(user, seededLedger(prng, user.id, 3));
      users.push(user);
    }
    const statuses = new Uint16Array(STRESS_USERS);
    gc?.();
    const heapBefore = Deno.memoryUsage();
    let coldRoundTrips = 0;
    const t0 = performance.now();
    for (let i = 0; i < STRESS_USERS; i += 1) {
      const user = users[i];
      const { response, calls } = await h.request(requestFor(user));
      statuses[i] = response.status;
      await response.body?.cancel();
      coldRoundTrips += countBy(calls, "auth") + countBy(calls, "postgrest");
      if (i % 1000 === 999) {
        // Keep the model's own bookkeeping from dominating the heap measurement.
        h.calls.length = 0;
        h.accessLog.length = 0;
        h.errorLog.length = 0;
      }
    }
    const wallMs = performance.now() - t0;
    h.calls.length = 0;
    h.accessLog.length = 0;
    h.errorLog.length = 0;
    gc?.();
    const heapAfter = Deno.memoryUsage();

    // Behavioural probe of the auth-cache cap (5,000 entries, oldest third dropped):
    // the most recent users must still be cached; with > 5,000 users the earliest cannot be.
    let recentHits = 0;
    const probeRecent = users.slice(-50);
    for (const u of probeRecent) {
      const { response, calls } = await h.request(requestFor(u));
      await response.body?.cancel();
      if (countBy(calls, "auth") === 0) recentHits += 1;
    }
    let earliestColdAgain = 0;
    const probeEarliest = users.slice(0, 50);
    for (const u of probeEarliest) {
      const { response, calls } = await h.request(requestFor(u));
      await response.body?.cancel();
      if (countBy(calls, "auth") === 1) earliestColdAgain += 1;
    }
    const report = {
      seed: STRESS_SEED,
      users: STRESS_USERS,
      wallMs: Math.round(wallMs),
      statusHistogram: histogram(Array.from(statuses)),
      supabaseRoundTripsTotal: coldRoundTrips,
      perUserRoundTrips: coldRoundTrips / STRESS_USERS,
      heap: {
        gcAvailable: Boolean(gc),
        before: heapBefore,
        after: heapAfter,
        heapUsedDeltaMB:
          Math.round(((heapAfter.heapUsed - heapBefore.heapUsed) / 1_048_576) * 100) / 100,
        rssDeltaMB: Math.round(((heapAfter.rss - heapBefore.rss) / 1_048_576) * 100) / 100,
        heapUsedPerUserBytes: Math.round((heapAfter.heapUsed - heapBefore.heapUsed) / STRESS_USERS),
      },
      authCacheProbe: {
        recentUsersProbed: probeRecent.length,
        recentHits,
        earliestUsersProbed: probeEarliest.length,
        earliestColdAgain,
      },
      replay: `${replayCommand(FILE, "L1 caches", STRESS_SEED)} (add --v8-flags=--expose-gc for a settled heap)`,
    };
    const path = await writeJson("l1_memory", report);
    console.log(
      `[stress] L1 memory: ${STRESS_USERS} users in ${report.wallMs}ms, heapUsed Δ=${report.heap.heapUsedDeltaMB}MB rss Δ=${report.heap.rssDeltaMB}MB, ` +
        `recent hits ${recentHits}/${probeRecent.length}, earliest cold again ${earliestColdAgain}/${probeEarliest.length} → ${path}`,
    );
    const invariants: Invariant[] = [
      {
        name: "every distinct user got 200",
        holds: statuses.every((s) => s === 200),
        detail: JSON.stringify(report.statusHistogram),
      },
      {
        name: "cold path is exactly 2 Supabase round trips per user",
        holds: coldRoundTrips === 2 * STRESS_USERS,
        detail: `${coldRoundTrips} for ${STRESS_USERS}`,
      },
      {
        name: "the 50 most recent bearers are still L1 hits",
        holds: recentHits === probeRecent.length,
        detail: `${recentHits}/${probeRecent.length}`,
      },
      {
        name:
          STRESS_USERS > 5000
            ? "the 50 earliest bearers were evicted (cap holds)"
            : "the 50 earliest bearers are still cached (below cap)",
        holds:
          STRESS_USERS > 5000
            ? earliestColdAgain === probeEarliest.length
            : earliestColdAgain === 0,
        detail: `${earliestColdAgain}/${probeEarliest.length} cold again`,
      },
    ];
    if (gc) {
      // Without --v8-flags=--expose-gc the delta is dominated by unreclaimed request garbage; report it, do not judge it.
      invariants.push({
        name: "settled heapUsed growth bounded (< 64MB)",
        holds: heapAfter.heapUsed - heapBefore.heapUsed < 64 * 1_048_576,
        detail: `${report.heap.heapUsedDeltaMB}MB after gc()`,
      });
    } else {
      console.log(
        "[stress] L1 memory: gc() not exposed — heap delta is unsettled and not asserted (add --v8-flags=--expose-gc)",
      );
    }
    assertInvariants(invariants, "L1 memory");
  },
);
