// W11-01 ADVERSARIAL TESTS — attack branch against candidate 1b40f8f2.
//
// Every test here is an ATTACK: it asserts the behaviour a venue behind one
// NAT egress (and the project's Supabase Auth budget) NEEDS, and lets the
// candidate fail where it does not deliver it. Nothing in this file touches
// the candidate's production code or its own test suite.
//
// Attacks:
//   1. Upstream amplification on a session route — a co-tenant's novel forged
//      ID tokens all reach Supabase Auth `/token` (base capped them at 30).
//   2. Same flood with Supabase Auth's documented per-IP `/token` token bucket
//      modelled — the venue's refresh / sign-in now fail 503 instead of 429.
//   3. Upstream amplification on POST /v1/auth/refresh (150 novel refresh
//      tokens in one 5-minute window all reach `/token`).
//   4. Upstream amplification on POST /v1/account/bootstrap.
//   5. Shard-store saturation from OTHER egresses disables replay throttling
//      for every venue (memory fallback fails open globally).
//   6. Classification oracle: under stuffing a dead-real token (401) and a
//      forged token (429) are distinguishable to the client.
//   7. A signed-out handset's refresh (`refresh_token_not_found`, the code
//      Auth returns for a logged-out session) is a "guess" and is answered
//      429 instead of 401 once the egress is under stuffing.
//   8. Window rollover: replay throttling resets and Retry-After is bounded.
//   9. Concurrency: 60 distinct forged bearers racing a peer's cache-expired
//      valid bearer.
//  10. Boundary bearers (NaN / far-future / string `exp`) charge at most once.
//  11. Whitespace / scheme-case variants of one forged bearer are one shard.
//  12. Liveness misclassification: a logged-out handset's refresh answers
//      `refresh_token_not_found` (GoTrue deletes the session on logout and
//      refresh_tokens.session_id cascades) — the candidate counts it as a
//      credential GUESS.
//  13. …so on the wire 30 signed-out venue handsets saturate the NAT-wide
//      stuffing signal and the 31st is told 429 instead of 401.
//
// Upstream model (VERIFIED against sources, not guessed):
//   * Supabase Auth applies its `/auth/v1/token` limiter per client IP
//     (docs: supabase.com/docs/guides/auth/rate-limits — "Token refresh …
//     150 per 5 minutes … Also covers sign-in with password/ID token/PKCE").
//   * GoTrue `internal/api/token.go` `Token()` calls `performRateLimiting`
//     (tollbooth token bucket, `RateLimitTokenRefresh` default 150 / 5 min,
//     burst 30) BEFORE dispatching id_token / refresh_token grants; the key is
//     `sb-forwarded-for` when present, else the caller (the Edge egress).
//   * GoTrue `internal/tokens/service.go` returns `refresh_token_not_found`
//     when the refresh token row is gone — which is what logout does
//     (`models.LogoutSession` deletes the session; `refresh_tokens_session_id_fkey`
//     is `on delete cascade`, migrations/20220811173540_add_sessions_table).
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json attack_w11_01_nat_budget.test.ts

import { assert, assertEquals } from "@std/assert";
import { peekRateLimit } from "../rateLimit.ts";
import { loadIsolate } from "./harness.ts";
import type { Harness, RecordedCall } from "./routesHarness.ts";
import {
  fakeSupabaseAccessToken,
  loadHarness,
  OTHER_USER_ID,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

/** Mirrors AUTH_FAILURE_LIMIT / AUTH_REFRESH_LIMIT / AUTH_BOOTSTRAP_LIMIT in index.ts. */
const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
const PER_MINUTE_ROUTE_LIMIT = 30;
const LIMIT = AUTH_FAILURE_LIMIT.limit;
/** Mirrors MEMORY_WINDOW_MAX in rateLimit.ts. */
const MEMORY_WINDOW_MAX = 20_000;
/** Supabase Auth `/token` defaults: 150 per 5 minutes, burst 30, per IP. */
const UPSTREAM_TOKEN_BURST = 30;
const UPSTREAM_TOKEN_PER_WINDOW = 150;
const UPSTREAM_TOKEN_WINDOW_MS = 300_000;

type Handler = (request: Request) => Promise<Response>;

const profile = (id = TEST_USER_ID) => ({
  id,
  email: "user@example.com",
  provider: "google",
  onboarding_state: "complete",
});

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const jwtOf = (payload: unknown): string =>
  `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.sig`;

const supabaseBearer = (salt: string, exp: unknown = Math.floor(Date.now() / 1000) + 3600) =>
  jwtOf({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub: TEST_USER_ID,
    aud: "authenticated",
    role: "authenticated",
    session_id: crypto.randomUUID(),
    exp,
    salt,
  });

const googleIdToken = (sub: string, exp = Math.floor(Date.now() / 1000) + 3600): string =>
  jwtOf({ iss: "https://accounts.google.com", sub, exp, salt: crypto.randomUUID() });

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const credentialRefused = () =>
  jsonResponse(403, {
    code: 403,
    error_code: "bad_jwt",
    msg: "invalid JWT: unable to parse or verify signature, token signature is invalid",
  });

const sessionGone = () =>
  jsonResponse(403, {
    code: 403,
    error_code: "session_not_found",
    msg: "Session from session_id claim in JWT does not exist",
  });

const refreshRefused = () =>
  jsonResponse(400, {
    error: "invalid_grant",
    error_description: "Invalid Refresh Token: Refresh Token Not Found",
    error_code: "refresh_token_not_found",
  });

const idTokenRefused = () =>
  jsonResponse(400, {
    error: "invalid_grant",
    error_description: "Bad ID token",
    error_code: "bad_id_token",
  });

/** GoTrue's answer once the per-IP `/token` bucket is empty. */
const upstreamThrottled = () =>
  jsonResponse(429, {
    code: 429,
    error_code: "over_request_rate_limit",
    msg: "Request rate limit reached",
  });

const mintedSession = (sub: string) =>
  jsonResponse(200, {
    access_token: fakeSupabaseAccessToken(sub),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: `rt-${crypto.randomUUID()}`,
    user: {
      id: sub,
      aud: "authenticated",
      role: "authenticated",
      email: "user@example.com",
      app_metadata: { provider: "google", providers: ["google"] },
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  });

const bearerOfCall = (call: RecordedCall): string =>
  (call.headers.authorization ?? "").replace(/^Bearer /, "");
const isUserCall = (call: RecordedCall) => call.url.startsWith(`${SUPABASE_URL}/auth/v1/user`);
const isTokenCall = (call: RecordedCall) => call.url.startsWith(`${SUPABASE_URL}/auth/v1/token`);
const isRefreshCall = (call: RecordedCall) =>
  isTokenCall(call) && call.url.includes("grant_type=refresh_token");
const isIdTokenCall = (call: RecordedCall) =>
  isTokenCall(call) && call.url.includes("grant_type=id_token");
const bodyField = (call: RecordedCall, field: string): string => {
  const body = call.body;
  if (typeof body !== "object" || body === null) return "";
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
};

let ipCounter = 0;
/** Unique egress per test (own /16: never collides with the candidate suite's 10.61/16). */
const freshIp = () => `10.62.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const spent = (window: { limit: number; remaining: number }) => window.limit - window.remaining;
const egressCharged = async (ip: string): Promise<number> =>
  spent(
    await peekRateLimit("authfail", ip, AUTH_FAILURE_LIMIT.limit, AUTH_FAILURE_LIMIT.windowSeconds),
  );

async function send(handler: Handler, request: Request): Promise<Response> {
  const response = await handler(request);
  await response.body?.cancel();
  return response;
}

const readMe = (handler: Handler, ip: string, bearer: string) =>
  send(handler, userRequest("GET", "/v1/me", { token: bearer, ip }));

const readMeWithAuthorization = (handler: Handler, ip: string, authorization: string) =>
  send(
    handler,
    new Request("http://edge.test/functions/v1/api/v1/me", {
      method: "GET",
      headers: { "x-forwarded-for": ip, Authorization: authorization },
    }),
  );

const refreshRequest = (ip: string, refreshToken: string) =>
  new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
    method: "POST",
    headers: { "x-forwarded-for": ip, "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });

const postRefresh = (handler: Handler, ip: string, refreshToken: string) =>
  send(handler, refreshRequest(ip, refreshToken));

const postBootstrap = (handler: Handler, ip: string, idToken: string) =>
  send(handler, userRequest("POST", "/v1/account/bootstrap", { token: idToken, ip, body: {} }));

async function sendJson(
  handler: Handler,
  request: Request,
): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const response = await handler(request);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return {
    status: response.status,
    headers: response.headers,
    body: typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {},
  };
}

const sessionAccessToken = (body: Record<string, unknown>): string => {
  const session = body.session;
  if (typeof session !== "object" || session === null) return "";
  const token = (session as Record<string, unknown>).accessToken;
  return typeof token === "string" ? token : "";
};

const repeat = async (times: number, run: () => Promise<Response>): Promise<number[]> => {
  const statuses: number[] = [];
  for (let i = 0; i < times; i += 1) statuses.push((await run()).status);
  return statuses;
};

const count = (statuses: number[], status: number) => statuses.filter((s) => s === status).length;

/** Pin `Date.now` to the first second of the NEXT auth-failure window (also a
 * fresh minute for the per-minute route budgets) and let the test move it. */
async function withPinnedClock(run: (clock: { advance(ms: number): void }) => Promise<void>) {
  const realNow = Date.now;
  const windowMs = AUTH_FAILURE_LIMIT.windowSeconds * 1_000;
  let now = (Math.floor(realNow() / windowMs) + 1) * windowMs + 1_000;
  Date.now = () => now;
  try {
    await run({
      advance(ms: number) {
        now += ms;
      },
    });
  } finally {
    Date.now = realNow;
  }
}

/** tollbooth / x/time/rate token bucket as GoTrue applies it to `/token`:
 * burst 30, refill 150 per 5 minutes, one bucket per (forwarded) client IP —
 * behind an anon-key edge that does not forward the client IP, one bucket
 * for the whole project. */
class UpstreamTokenBucket {
  private tokens = UPSTREAM_TOKEN_BURST;
  private lastMs = Date.now();
  taken = 0;
  refused = 0;

  take(): boolean {
    const nowMs = Date.now();
    const elapsed = Math.max(0, nowMs - this.lastMs);
    this.lastMs = nowMs;
    this.tokens = Math.min(
      UPSTREAM_TOKEN_BURST,
      this.tokens + (elapsed / UPSTREAM_TOKEN_WINDOW_MS) * UPSTREAM_TOKEN_PER_WINDOW,
    );
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.taken += 1;
      return true;
    }
    this.refused += 1;
    return false;
  }
}

/** Route every `/token` call through the upstream bucket: live credentials
 * mint a session, anything else is refused as a guess, and an empty bucket
 * answers 429 for EVERYONE (that is the whole point of a per-IP limiter). */
function installUpstreamTokenLimiter(
  h: Harness,
  live: { refreshTokens: Set<string>; idTokens: Set<string> },
): UpstreamTokenBucket {
  const bucket = new UpstreamTokenBucket();
  h.respond = (call) => {
    if (isRefreshCall(call)) {
      if (!bucket.take()) return upstreamThrottled();
      return live.refreshTokens.has(bodyField(call, "refresh_token"))
        ? mintedSession(TEST_USER_ID)
        : refreshRefused();
    }
    if (isIdTokenCall(call)) {
      if (!bucket.take()) return upstreamThrottled();
      return live.idTokens.has(bodyField(call, "id_token"))
        ? mintedSession(OTHER_USER_ID)
        : idTokenRefused();
    }
    if (isUserCall(call)) {
      return bearerOfCall(call).includes(".") ? null : credentialRefused();
    }
    return null;
  };
  return bucket;
}

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 1–2 — upstream amplification on a session route + modelled Auth limiter
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "ATTACK 1: a co-tenant's novel forged ID tokens on GET /v1/me reach Supabase Auth /token no more than the auth-failure budget allows",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const bucket = installUpstreamTokenLimiter(h, {
        refreshTokens: new Set(),
        idTokens: new Set(),
      });

      const flood = 200;
      const statuses: number[] = [];
      for (let i = 0; i < flood; i += 1) {
        statuses.push((await readMe(h.handler, ip, googleIdToken(crypto.randomUUID()))).status);
        clock.advance(300);
      }
      const upstreamGrants = h.calls.filter(isIdTokenCall).length;
      assert(
        upstreamGrants <= LIMIT,
        `one egress must not be able to spend more than the auth-failure budget (${LIMIT}) on ` +
          `Supabase Auth /token per window; ${upstreamGrants} of ${flood} forged ID tokens reached Auth ` +
          `(edge answered 401×${count(statuses, 401)} 429×${count(statuses, 429)} 503×${count(
            statuses,
            503,
          )}; upstream bucket took ${bucket.taken}, refused ${bucket.refused}; egress charged ${await egressCharged(
            ip,
          )})`,
      );
    });
  },
);

Deno.test(
  "ATTACK 2: with Supabase Auth's per-IP /token bucket modelled, a valid peer's refresh and a new handset's sign-in survive a co-tenant's forged-ID-token flood",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const liveRefreshToken = `rt-live-${crypto.randomUUID()}`;
      const newHandset = googleIdToken(OTHER_USER_ID);
      const bucket = installUpstreamTokenLimiter(h, {
        refreshTokens: new Set([liveRefreshToken]),
        idTokens: new Set([newHandset]),
      });

      // A peer's established Supabase session, verified once and cached.
      const established = fakeSupabaseAccessToken(TEST_USER_ID);
      assertEquals(
        (await readMe(h.handler, ip, established)).status,
        200,
        "peer read before flood",
      );

      for (let i = 0; i < 200; i += 1) {
        await readMe(h.handler, ip, googleIdToken(crypto.randomUUID()));
        clock.advance(300);
      }

      const cachedRead = await readMe(h.handler, ip, established);
      const refresh = await sendJson(h.handler, refreshRequest(ip, liveRefreshToken));
      const rotated = sessionAccessToken(refresh.body);
      const rotatedRead = rotated ? (await readMe(h.handler, ip, rotated)).status : 0;
      const bootstrap = await sendJson(
        h.handler,
        userRequest("POST", "/v1/account/bootstrap", { token: newHandset, ip, body: {} }),
      );
      const minted = sessionAccessToken(bootstrap.body);
      const mintedRead = minted ? (await readMe(h.handler, ip, minted)).status : 0;

      assertEquals(
        {
          cachedRead: cachedRead.status,
          refresh: refresh.status,
          rotatedRead,
          bootstrap: bootstrap.status,
          mintedRead,
        },
        { cachedRead: 200, refresh: 200, rotatedRead: 200, bootstrap: 200, mintedRead: 200 },
        `venue peers must stay online during a co-tenant flood (upstream /token bucket took ${bucket.taken}, ` +
          `refused ${bucket.refused}; refresh body ${JSON.stringify(refresh.body)}; bootstrap body ${JSON.stringify(
            bootstrap.body,
          )})`,
      );
    });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 3–4 — upstream amplification on the refresh and bootstrap routes
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "ATTACK 3: 150 novel forged refresh tokens in one auth-failure window reach Supabase Auth /token no more than the budget allows",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      const ip = freshIp();
      h.respond = (call) => (isRefreshCall(call) ? refreshRefused() : null);

      const statuses: number[] = [];
      for (let minute = 0; minute < 5; minute += 1) {
        for (let i = 0; i < PER_MINUTE_ROUTE_LIMIT; i += 1) {
          statuses.push(
            (await postRefresh(h.handler, ip, `rt-forged-${crypto.randomUUID()}`)).status,
          );
        }
        if (minute < 4) clock.advance(60_000);
      }
      const upstreamGrants = h.calls.filter(isRefreshCall).length;
      assert(
        upstreamGrants <= LIMIT,
        `one egress spent ${upstreamGrants} Supabase Auth refresh grants in one window (budget ${LIMIT}; ` +
          `Supabase's own per-IP default is ${UPSTREAM_TOKEN_PER_WINDOW}) — edge answered 401×${count(
            statuses,
            401,
          )} 429×${count(statuses, 429)}; egress charged ${await egressCharged(ip)}`,
      );
    });
  },
);

Deno.test(
  "ATTACK 4: 150 novel forged ID tokens on POST /v1/account/bootstrap in one window reach Supabase Auth /token no more than the budget allows",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      const ip = freshIp();
      h.respond = (call) => (isIdTokenCall(call) ? idTokenRefused() : null);

      const statuses: number[] = [];
      for (let minute = 0; minute < 5; minute += 1) {
        for (let i = 0; i < PER_MINUTE_ROUTE_LIMIT; i += 1) {
          statuses.push(
            (await postBootstrap(h.handler, ip, googleIdToken(crypto.randomUUID()))).status,
          );
        }
        if (minute < 4) clock.advance(60_000);
      }
      const upstreamGrants = h.calls.filter(isIdTokenCall).length;
      assert(
        upstreamGrants <= LIMIT,
        `one egress spent ${upstreamGrants} Supabase Auth id_token grants in one window (budget ${LIMIT}) — ` +
          `edge answered 401×${count(statuses, 401)} 429×${count(statuses, 429)}; egress charged ${await egressCharged(
            ip,
          )}`,
      );
    });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 5 — shard-store saturation from OTHER egresses (memory fallback)
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "ATTACK 5: attackers on other egresses filling the shard store must not switch off replay throttling for a venue",
  async () => {
    const isolate = await loadIsolate();
    const rl = isolate.rateLimit as unknown as Record<string, unknown>;
    const chargeAuthFailure = rl.chargeAuthFailure as (
      ip: string,
      identity: string | null,
      refusal: { kind: string },
      budget: { limit: number; windowSeconds: number },
    ) => Promise<unknown>;
    const peekAuthFailureBudget = rl.peekAuthFailureBudget as (
      ip: string,
      identity: string | null,
      budget: { limit: number; windowSeconds: number },
    ) => Promise<{ allowed: boolean; remaining: number }>;
    assert(
      typeof chargeAuthFailure === "function" && typeof peekAuthFailureBudget === "function",
      "candidate exports chargeAuthFailure / peekAuthFailureBudget",
    );

    const venue = "198.51.100.7";
    const attackers = ["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4"];

    // Sanity: before anyone else shows up, a refused credential replayed 30
    // times on the venue egress is throttled on its 31st presentation.
    const early = "sha-early-refused";
    for (let i = 0; i < LIMIT; i += 1) {
      await chargeAuthFailure(venue, early, { kind: "credential" }, AUTH_FAILURE_LIMIT);
    }
    assertEquals(
      (await peekAuthFailureBudget(venue, early, AUTH_FAILURE_LIMIT)).allowed,
      false,
      "precondition: replay throttling works while the store has room",
    );

    // Four unrelated egresses each guess 5 000 distinct credentials.
    for (let i = 0; i < MEMORY_WINDOW_MAX; i += 1) {
      await chargeAuthFailure(
        attackers[i % attackers.length],
        `sha-guess-${i}`,
        { kind: "credential" },
        AUTH_FAILURE_LIMIT,
      );
    }

    // Now a stuffer on the VENUE egress replays one refused credential 30 times.
    const late = "sha-late-refused";
    for (let i = 0; i < LIMIT; i += 1) {
      await chargeAuthFailure(venue, late, { kind: "credential" }, AUTH_FAILURE_LIMIT);
    }
    const peek = await peekAuthFailureBudget(venue, late, AUTH_FAILURE_LIMIT);
    assertEquals(
      peek.allowed,
      false,
      `after ${LIMIT} refusals of the same credential on the venue egress its 31st presentation must be ` +
        `throttled before Auth, but the shard store (filled by ${attackers.length} OTHER egresses) reports ` +
        `remaining=${peek.remaining} and lets it through`,
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 6–7 — what the client can learn / a signed-out handset under stuffing
// ═════════════════════════════════════════════════════════════════════════════

/** Drive the egress to the stuffing threshold with 30 distinct forged bearers. */
async function saturateEgress(h: Harness, ip: string) {
  const prior = h.respond;
  h.respond = (call) => (isUserCall(call) ? credentialRefused() : prior(call));
  const statuses = await repeat(LIMIT, () =>
    readMe(h.handler, ip, supabaseBearer(crypto.randomUUID())),
  );
  h.respond = prior;
  assertEquals(await egressCharged(ip), LIMIT, `egress saturated (${statuses.join(",")})`);
}

Deno.test(
  "ATTACK 6: once the egress is under stuffing, a dead-real session bearer and a forged bearer must be indistinguishable to the client",
  async () => {
    await withPinnedClock(async () => {
      const h = await loadHarness();
      const ip = freshIp();
      await saturateEgress(h, ip);

      h.respond = (call) => (isUserCall(call) ? sessionGone() : null);
      const deadReal = await readMe(h.handler, ip, supabaseBearer("dead-real"));
      h.respond = (call) => (isUserCall(call) ? credentialRefused() : null);
      const forged = await readMe(h.handler, ip, supabaseBearer("forged"));

      assertEquals(
        deadReal.status,
        forged.status,
        `status oracle: a token Auth knows (liveness) answers ${deadReal.status} while a token Auth ` +
          `does not know (credential) answers ${forged.status} — the classification leaks to the caller`,
      );
    });
  },
);

Deno.test(
  "ATTACK 7: a signed-out handset's refresh (refresh_token_not_found) is still answered 401 — the app's sign-out signal — while a co-tenant stuffs the egress",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      const ip = freshIp();
      h.respond = (call) => (isRefreshCall(call) ? refreshRefused() : null);

      // 30 distinct forged refresh tokens from the stuffer (one minute each 30).
      const stuffing = await repeat(PER_MINUTE_ROUTE_LIMIT, () =>
        postRefresh(h.handler, ip, `rt-forged-${crypto.randomUUID()}`),
      );
      assertEquals(
        count(stuffing, 401),
        PER_MINUTE_ROUTE_LIMIT,
        `stuffer refused: ${stuffing.join(",")}`,
      );
      clock.advance(60_000);

      // A real handset whose session was ended elsewhere (logout / deletion):
      // Auth answers refresh_token_not_found for a refresh token whose row is
      // gone. The app treats 401 as "sign out"; 429 keeps it retrying.
      const signedOutHandset = await postRefresh(
        h.handler,
        ip,
        `rt-signed-out-${crypto.randomUUID()}`,
      );
      assertEquals(
        signedOutHandset.status,
        401,
        `signed-out handset must be told its session is gone (401), got ${signedOutHandset.status} ` +
          `Retry-After=${signedOutHandset.headers.get("Retry-After")} (egress charged ${await egressCharged(ip)})`,
      );
    });
  },
);

Deno.test(
  "ATTACK 12: authRefusalKind classifies GoTrue's refresh_token_not_found (the answer to a logged-out handset's refresh) as liveness, not a credential guess",
  async () => {
    const isolate = await loadIsolate();
    const rl = isolate.rateLimit as unknown as Record<string, unknown>;
    const authRefusalKind = rl.authRefusalKind as (body: unknown) => string;
    assert(typeof authRefusalKind === "function", "candidate exports authRefusalKind");
    assertEquals(
      authRefusalKind({
        error: "invalid_grant",
        error_description: "Invalid Refresh Token: Refresh Token Not Found",
        error_code: "refresh_token_not_found",
      }),
      "liveness",
      "a refresh token GoTrue no longer holds is a session fenced by logout/deletion, not a guessed credential",
    );
  },
);

Deno.test(
  "ATTACK 13: on the wire, thirty logged-out venue handsets refreshing leave the NAT-wide stuffing signal at 0 and the 31st dead session is still told 401",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      const ip = freshIp();
      h.respond = (call) => (isRefreshCall(call) ? refreshRefused() : null);

      // A venue's handsets, each signed out from another device (scope=local
      // logout of THAT session, or account deletion), come back online and
      // rotate the refresh token they still hold.
      const handsets = await repeat(PER_MINUTE_ROUTE_LIMIT, () =>
        postRefresh(h.handler, ip, `rt-logged-out-${crypto.randomUUID()}`),
      );
      assertEquals(
        count(handsets, 401),
        PER_MINUTE_ROUTE_LIMIT,
        `handsets refused: ${handsets.join(",")}`,
      );
      assertEquals(
        await egressCharged(ip),
        0,
        "dead real sessions are charged to their own shard only — the NAT-wide stuffing signal must stay untouched",
      );

      clock.advance(60_000);
      const thirtyFirst = await postRefresh(h.handler, ip, `rt-logged-out-${crypto.randomUUID()}`);
      assertEquals(
        thirtyFirst.status,
        401,
        `the 31st signed-out handset must receive its sign-out signal (401), got ${thirtyFirst.status} ` +
          `Retry-After=${thirtyFirst.headers.get("Retry-After")}`,
      );
    });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 8 — window rollover / Retry-After bound
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "ATTACK 8: a replay-throttled credential is re-judged by Auth after the window rolls, and every 429 carries a bounded Retry-After",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      const ip = freshIp();
      h.respond = (call) => (isUserCall(call) ? credentialRefused() : null);
      const bearer = supabaseBearer("replayed");

      const first = await repeat(LIMIT, () => readMe(h.handler, ip, bearer));
      assertEquals(count(first, 401), LIMIT, `refused 30 times: ${first.join(",")}`);
      const throttled = await readMe(h.handler, ip, bearer);
      assertEquals(throttled.status, 429, "31st presentation is throttled");
      const retryAfter = Number(throttled.headers.get("Retry-After"));
      assert(
        Number.isInteger(retryAfter) &&
          retryAfter >= 1 &&
          retryAfter <= AUTH_FAILURE_LIMIT.windowSeconds,
        `Retry-After must be within the window, got ${retryAfter}`,
      );
      const authCallsBefore = h.calls.filter(isUserCall).length;
      assertEquals(authCallsBefore, LIMIT, "the throttled replay never reached Auth");

      clock.advance(AUTH_FAILURE_LIMIT.windowSeconds * 1_000);
      const afterRoll = await readMe(h.handler, ip, bearer);
      assertEquals(afterRoll.status, 401, "after the window rolls the credential is judged again");
      assertEquals(h.calls.filter(isUserCall).length, authCallsBefore + 1, "…by Auth");
    });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 9 — concurrency: 60 distinct forged bearers racing a peer's valid one
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "ATTACK 9: 60 concurrent distinct forged bearers cannot deny a peer whose valid bearer is being re-verified at the same time",
  async () => {
    await withPinnedClock(async () => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const peer = fakeSupabaseAccessToken(TEST_USER_ID);
      h.respond = (call) => {
        if (!isUserCall(call)) return null;
        return bearerOfCall(call) === peer ? null : credentialRefused();
      };

      const forged = Array.from({ length: 2 * LIMIT }, () => supabaseBearer(crypto.randomUUID()));
      const results = await Promise.all([
        ...forged.map((bearer) => readMe(h.handler, ip, bearer)),
        readMe(h.handler, ip, peer),
      ]);
      const statuses = results.map((r) => r.status);
      const peerStatus = statuses.pop();
      assertEquals(
        peerStatus,
        200,
        `peer racing the flood must be served (flood: ${statuses.join(",")})`,
      );
      assert(
        statuses.every((s) => s === 401 || s === 429),
        `forged bearers are refused or throttled only: ${statuses.join(",")}`,
      );
      assertEquals(await egressCharged(ip), LIMIT, "stuffing signal is capped at the budget");
      assertEquals(
        (await readMe(h.handler, ip, peer)).status,
        200,
        "peer still served after the race",
      );
    });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 10 — boundary `exp` claims
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "ATTACK 10: bearers with NaN / far-future / string / negative exp are each either refused locally or charged exactly once, and a peer stays served",
  async () => {
    await withPinnedClock(async () => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const peer = fakeSupabaseAccessToken(TEST_USER_ID);
      h.respond = (call) => {
        if (!isUserCall(call)) return null;
        return bearerOfCall(call) === peer ? null : credentialRefused();
      };
      assertEquals((await readMe(h.handler, ip, peer)).status, 200, "peer before");

      const odd = [
        supabaseBearer("nan", Number.NaN),
        supabaseBearer("far-future", 1e18),
        supabaseBearer("string", "4102444800"),
        supabaseBearer("negative", -1),
        supabaseBearer("null", null),
        supabaseBearer("absent", undefined),
      ];
      for (const bearer of odd) {
        const authBefore = h.calls.filter(isUserCall).length;
        const chargedBefore = await egressCharged(ip);
        const first = await readMe(h.handler, ip, bearer);
        const second = await readMe(h.handler, ip, bearer);
        const reachedAuth = h.calls.filter(isUserCall).length - authBefore;
        const charged = (await egressCharged(ip)) - chargedBefore;
        assert(
          (reachedAuth === 0 && charged === 0 && first.status === 401 && second.status === 401) ||
            (reachedAuth === 2 && charged === 1 && first.status === 401 && second.status === 401),
          `odd exp bearer: statuses ${first.status}/${second.status}, reachedAuth=${reachedAuth}, charged=${charged}`,
        );
      }
      assertEquals((await readMe(h.handler, ip, peer)).status, 200, "peer after");
    });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 11 — header variants of one forged bearer are one shard
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "ATTACK 11: whitespace variants of one refused bearer share a shard (31st presentation is 429); tab-separated and lowercase schemes are local refusals that charge nothing",
  async () => {
    await withPinnedClock(async () => {
      const h = await loadHarness();
      const ip = freshIp();
      h.respond = (call) => (isUserCall(call) ? credentialRefused() : null);
      const token = supabaseBearer("variants");
      const variants = [`Bearer ${token}`, `Bearer  ${token}`, `Bearer ${token} `];

      const statuses: number[] = [];
      for (let i = 0; i < LIMIT; i += 1) {
        statuses.push(
          (await readMeWithAuthorization(h.handler, ip, variants[i % variants.length])).status,
        );
      }
      const throttled = await readMeWithAuthorization(h.handler, ip, variants[1]);
      assertEquals(
        throttled.status,
        429,
        `variants of one refused credential must share its shard: ${statuses.join(",")} then ${throttled.status} ` +
          `(Auth calls ${h.calls.filter(isUserCall).length})`,
      );

      const charged = await egressCharged(ip);
      const authCalls = h.calls.filter(isUserCall).length;
      for (const local of [
        `bearer ${supabaseBearer("lower")}`,
        `Bearer\t${supabaseBearer("tab")}`,
      ]) {
        const refused = await readMeWithAuthorization(h.handler, ip, local);
        assertEquals(refused.status, 401, `${JSON.stringify(local.slice(0, 8))} is refused`);
      }
      assertEquals(h.calls.filter(isUserCall).length, authCalls, "…without reaching Auth");
      assertEquals(await egressCharged(ip), charged, "…and charging nothing");
    });
  },
);
