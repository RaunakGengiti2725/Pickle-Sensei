// W11-01 ADVERSARIAL TESTS — auth-failure budgets behind NAT (candidate f66ec47a).
//
// Each test is an ATTACK on the candidate's stated contract (rateLimit.ts
// header comment, rateLimit_nat_budget.test.ts header, implementer summary):
//
//   C1 "the 31st presentation of one refused credential in a window is 429
//       before Auth, whoever else shares the IP"
//   C2 "LIVENESS refusals … charge their shard only — a signed-out handset
//       retrying is not an attack"; "one NAT egress cannot lock out a venue"
//   C3 "Refresh budgets the refresh token in its body, not the bearer header"
//   C4 index.ts:5032-5034 "IPs that keep failing authentication (token
//       stuffing / credential probing) — those never even reach Supabase Auth
//       once tripped"
//
// Tests whose title starts with BREAK assert the CONTRACT (expected behaviour)
// and therefore FAIL on the candidate — the failure output is the reproduction.
// Tests whose title starts with HOLDS pass on the candidate (attack tried, no
// break). Nothing here modifies the candidate's code or tests.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json attack_w11_nat_budget.test.ts

import { assert, assertEquals } from "@std/assert";
import { chargeAuthFailure, peekAuthFailureBudget, peekRateLimit } from "../rateLimit.ts";
import { configureRedis, loadIsolate } from "./harness.ts";
import type { RecordedCall } from "./routesHarness.ts";
import {
  fakeSupabaseAccessToken,
  loadHarness,
  OTHER_USER_ID,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

/** Mirrors AUTH_FAILURE_LIMIT in index.ts. */
const BUDGET = { limit: 30, windowSeconds: 300 };
const LIMIT = BUDGET.limit;
/** Mirrors MEMORY_WINDOW_MAX in rateLimit.ts. */
const MEMORY_WINDOW_MAX = 20_000;

type Handler = (request: Request) => Promise<Response>;
type Harness = Awaited<ReturnType<typeof loadHarness>>;

const profile = (id: string) => ({
  id,
  email: "user@example.com",
  provider: "google",
  onboarding_state: "complete",
});

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const jwtOf = (payload: unknown): string =>
  `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.sig`;

/** A Supabase-shaped access token Auth will judge; `salt` keeps bearers distinct. */
const supabaseBearer = (salt: string): string =>
  jwtOf({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub: TEST_USER_ID,
    aud: "authenticated",
    role: "authenticated",
    session_id: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 3600,
    salt,
  });

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const badJwt = () =>
  jsonResponse(403, {
    code: 403,
    error_code: "bad_jwt",
    msg: "invalid JWT: unable to parse or verify signature, token signature is invalid",
  });
const sessionNotFound = () =>
  jsonResponse(403, {
    code: 403,
    error_code: "session_not_found",
    msg: "Session from session_id claim in JWT does not exist",
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
const isRefreshCall = (call: RecordedCall) =>
  call.url.startsWith(`${SUPABASE_URL}/auth/v1/token`) &&
  call.url.includes("grant_type=refresh_token");
const isAuthCall = (call: RecordedCall) => call.url.startsWith(`${SUPABASE_URL}/auth/v1/`);

let ipCounter = 0;
/** Unique egress per test (own /16 — no collision with the candidate's 10.71/16). */
const freshIp = () => `10.81.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const spent = (window: { limit: number; remaining: number }) => window.limit - window.remaining;
const EXACT = 1_000_000;
/** Distinct refused credentials charged to the egress — the stuffing signal. */
const egressCharged = async (ip: string): Promise<number> =>
  spent(await peekRateLimit("authfail", ip, EXACT, BUDGET.windowSeconds));

async function send(handler: Handler, request: Request): Promise<Response> {
  const response = await handler(request);
  await response.body?.cancel();
  return response;
}

const readMe = (handler: Handler, ip: string, bearer: string) =>
  send(handler, userRequest("GET", "/v1/me", { token: bearer, ip }));

const refreshRequest = (ip: string, refreshToken: string, bearer?: string) =>
  new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
    method: "POST",
    headers: {
      "x-forwarded-for": ip,
      "content-type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ refreshToken }),
  });

const authCallsSince = (h: Harness, mark: number) => h.calls.slice(mark).filter(isAuthCall);

function respondWith(h: Harness, layer: (call: RecordedCall) => Response | null) {
  const previous = h.respond;
  h.respond = async (call) => layer(call) ?? (await previous(call));
}

/** One co-tenant presents `count` DISTINCT forged bearers, each judged and
 * refused by Auth as a guess (bad_jwt). Returns the forged set. */
async function stuff(h: Harness, ip: string, count: number): Promise<string[]> {
  const forged = Array.from({ length: count }, (_, i) => supabaseBearer(`stuff-${i}-${ip}`));
  const set = new Set(forged);
  respondWith(h, (call) => (isUserCall(call) && set.has(bearerOfCall(call)) ? badJwt() : null));
  for (const bearer of forged) {
    assertEquals((await readMe(h.handler, ip, bearer)).status, 401, "guess judged");
  }
  return forged;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 1 — corrupt/partial state: the shard store is attacker-fillable and
// fails OPEN, which switches the WHOLE auth-failure budget off (primitives).
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "BREAK 1 (primitives): after MEMORY_WINDOW_MAX distinct guesses the shard store fails open — a NEW credential refused 200 times is still admitted and never raises the egress signal (C1 broken; whole budget disabled by cardinality)",
  async () => {
    configureRedis(false);
    const { rateLimit } = await loadIsolate();
    const ip = "198.51.100.31";
    for (let i = 0; i < MEMORY_WINDOW_MAX; i += 1) {
      await rateLimit.chargeAuthFailure(ip, `flood-${i}`, { kind: "credential" }, BUDGET);
    }
    const signalBefore = spent(
      await rateLimit.peekRateLimit("authfail", ip, EXACT, BUDGET.windowSeconds),
    );

    // A brand-new credential is refused 200 times — far past the 30 budget.
    for (let i = 0; i < 200; i += 1) {
      await rateLimit.chargeAuthFailure(ip, "victim-guess", { kind: "credential" }, BUDGET);
    }
    const signalAfter = spent(
      await rateLimit.peekRateLimit("authfail", ip, EXACT, BUDGET.windowSeconds),
    );
    const peek = await rateLimit.peekAuthFailureBudget(ip, "victim-guess", BUDGET);

    // Contract C1: the 31st presentation of a refused credential is refused.
    assertEquals(
      peek.allowed,
      false,
      `C1: a credential refused 200× in the window must be refused (observed allowed=${peek.allowed}, remaining=${peek.remaining}, egress signal ${signalBefore} → ${signalAfter}: the 200 refusals raised it by ${signalAfter - signalBefore})`,
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 2 — same, through the REAL handler, across IPs: a flood charged on
// egress A disables replay gating for egress B; the store self-heals after
// the short flood window so the rest of the suite is unaffected.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "BREAK 2 (route): a flood of distinct guesses from egress A disables per-credential gating for egress B — one forged bearer replayed 40× is judged by Auth 40× (never 429), then the store recovers once the flood window expires",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile(TEST_USER_ID)];
    const floodIp = freshIp();
    const victimIp = freshIp();
    // Flood shards live in a short aligned window so they expire in seconds:
    // the store is full DURING the attack and heals afterwards.
    const floodBudget = { limit: LIMIT, windowSeconds: 4 };
    const floodResetAtMs =
      (Math.floor(Date.now() / (floodBudget.windowSeconds * 1_000)) + 1) *
      floodBudget.windowSeconds *
      1_000;
    for (let i = 0; i < MEMORY_WINDOW_MAX; i += 1) {
      await chargeAuthFailure(floodIp, `flood-${i}`, { kind: "credential" }, floodBudget);
    }

    const forged = supabaseBearer("replayed-under-flood");
    respondWith(h, (call) => (isUserCall(call) && bearerOfCall(call) === forged ? badJwt() : null));
    const mark = h.calls.length;
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + 10; i += 1) {
      statuses.push((await readMe(h.handler, victimIp, forged)).status);
    }
    const judged = authCallsSince(h, mark).filter(isUserCall).length;
    const recovered = Date.now() >= floodResetAtMs;

    // Recovery check (also keeps the shared module store clean for later tests).
    await sleep(Math.max(0, floodResetAtMs - Date.now()) + 150);
    const healIp = freshIp();
    for (let i = 0; i < LIMIT; i += 1) {
      await chargeAuthFailure(healIp, "post-flood", { kind: "credential" }, BUDGET);
    }
    assertEquals(
      (await peekAuthFailureBudget(healIp, "post-flood", BUDGET)).allowed,
      false,
      "store must recover once the flood shards expire",
    );

    assert(!recovered, "attack must have run while the flood shards were live");
    // Contract C1: presentations 31..40 of the same refused credential are 429
    // before Auth, so Auth judges it at most 30 times.
    assert(
      judged <= LIMIT && statuses.slice(LIMIT).every((s) => s === 429),
      `C1: Auth judged the same forged bearer ${judged}× (max ${LIMIT}); statuses after #30: ${statuses.slice(LIMIT).join(",")}`,
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 3 — replay + co-tenant: a signed-out peer's ONE liveness 401 makes its
// next request 429 (retryable) instead of 401 (sign out) once a co-tenant
// stuffs — the venue's sign-out signal is suppressed by another handset.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "BREAK 3 (route): a peer whose session is dead (one liveness 401) is answered 429 instead of 401 on its next read once a co-tenant has stuffed 30 guesses — the app's only sign-out signal is withheld by another handset (C2 broken)",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile(TEST_USER_ID)];
    const ip = freshIp();
    const dead = fakeSupabaseAccessToken(TEST_USER_ID);
    respondWith(h, (call) =>
      isUserCall(call) && bearerOfCall(call) === dead ? sessionNotFound() : null,
    );

    // The signed-out handset learns once that its session is gone.
    assertEquals((await readMe(h.handler, ip, dead)).status, 401, "liveness refusal");
    assertEquals(await egressCharged(ip), 0, "liveness is not stuffing");

    // A co-tenant guesses 30 distinct credentials.
    await stuff(h, ip, LIMIT);
    assertEquals(await egressCharged(ip), LIMIT, "egress under stuffing");

    // The handset asks again (the app retries; sessionKeeper re-checks on
    // foreground). Contract C2: a dead credential is a liveness matter of its
    // own shard (1 of 30 spent) — Auth answers and the app gets its 401.
    const mark = h.calls.length;
    const response = await readMe(h.handler, ip, dead);
    assertEquals(
      response.status,
      401,
      `C2: second presentation of a dead session must be 401 (sign out), observed ${response.status} with Retry-After ${response.headers.get("Retry-After")}, Auth consulted ${authCallsSince(h, mark).length}×`,
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 4 — interleaved account switch / stale bearer: POST /v1/auth/refresh is
// gated by the Authorization HEADER credential, not the body's refresh token.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "BREAK 4 (route): refresh with a stale bearer header (refused once by Auth) and a NEVER-refused live refresh token in the body is 429 before Auth once a co-tenant stuffs — the body credential is not what gates the rotation (C3 broken)",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile(TEST_USER_ID)];
    const ip = freshIp();
    const stale = fakeSupabaseAccessToken(TEST_USER_ID);
    const liveRefresh = `rt-${crypto.randomUUID()}`;
    respondWith(h, (call) => {
      if (isUserCall(call) && bearerOfCall(call) === stale) return sessionNotFound();
      if (isRefreshCall(call)) return mintedSession(OTHER_USER_ID);
      return null;
    });

    // The device's previous session token is dead (account switch / remote
    // sign-out): one liveness 401.
    assertEquals((await readMe(h.handler, ip, stale)).status, 401);
    await stuff(h, ip, LIMIT);

    // Without a bearer the SAME refresh token rotates fine — proving the body
    // credential is live and never refused.
    const bare = await send(h.handler, refreshRequest(ip, `rt-${crypto.randomUUID()}`));
    assertEquals(bare.status, 200, "a live refresh token rotates when no header rides along");

    // With the stale bearer riding along (as the app's per-request bearer does):
    const mark = h.calls.length;
    const response = await send(h.handler, refreshRequest(ip, liveRefresh, stale));
    assertEquals(
      response.status,
      200,
      `C3: refresh must be judged by the body's refresh token; observed ${response.status} (Retry-After ${response.headers.get("Retry-After")}), Auth refresh calls: ${authCallsSince(h, mark).filter(isRefreshCall).length}`,
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 5 — network/throughput: distinct-credential probing is no longer
// stopped before Auth — every distinct guess costs one Auth round trip.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "BREAK 5 (route): 200 distinct forged bearers from ONE egress in one window all reach Supabase Auth (base stopped at 30) — the pre-auth stuffing brake documented at index.ts:5032-5034 no longer holds for distinct credentials (C4 broken)",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile(TEST_USER_ID)];
    const ip = freshIp();
    const mark = h.calls.length;
    const forged = await stuff(h, ip, 200);
    const judged = authCallsSince(h, mark).filter(isUserCall).length;
    assertEquals(forged.length, 200);
    // Contract C4: once the egress is tripped (30), guesses "never even reach
    // Supabase Auth".
    assert(
      judged <= LIMIT,
      `C4: Auth judged ${judged} distinct guesses from one egress in one window (budget ${LIMIT}); egress signal = ${await egressCharged(ip)}`,
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 6 — concurrency: parallel replays of ONE refused credential.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "BREAK 6 (route, concurrency): 120 parallel presentations of ONE forged bearer — peek-then-charge lets far more than 30 reach Auth (C1 holds only serially)",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile(TEST_USER_ID)];
    const ip = freshIp();
    const forged = supabaseBearer("parallel-replay");
    respondWith(h, (call) => (isUserCall(call) && bearerOfCall(call) === forged ? badJwt() : null));
    const mark = h.calls.length;
    const responses = await Promise.all(
      Array.from({ length: 120 }, () => readMe(h.handler, ip, forged)),
    );
    const judged = authCallsSince(h, mark).filter(isUserCall).length;
    const refused = responses.filter((r) => r.status === 429).length;
    assert(
      judged <= LIMIT,
      `C1: one refused credential must reach Auth at most ${LIMIT}× per window; observed ${judged} Auth verdicts, ${refused} × 429 out of 120`,
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 7 — response leakage / oracle: a 429 from an exhausted shard vs. one
// from the egress gate must be indistinguishable on the wire.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "HOLDS 7 (route): shard-exhausted 429 and egress-gated 429 are byte-identical apart from Retry-After/request id, carry no digest, and a 401 body never names the classification",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile(TEST_USER_ID)];
    const ip = freshIp();
    const exhausted = supabaseBearer("exhausted");
    respondWith(h, (call) =>
      isUserCall(call) && bearerOfCall(call) === exhausted ? badJwt() : null,
    );
    for (let i = 0; i < LIMIT; i += 1) {
      assertEquals((await readMe(h.handler, ip, exhausted)).status, 401);
    }
    const byShard = await h.handler(userRequest("GET", "/v1/me", { token: exhausted, ip }));
    const shardText = await byShard.text();
    assertEquals(byShard.status, 429);

    const [gated] = await stuff(h, ip, LIMIT);
    const byEgress = await h.handler(userRequest("GET", "/v1/me", { token: gated, ip }));
    const egressText = await byEgress.text();
    assertEquals(byEgress.status, 429);

    assertEquals(shardText, egressText, "identical bodies");
    const strip = (headers: Headers) =>
      [...headers.entries()].filter(([k]) => !["x-request-id", "retry-after"].includes(k)).sort();
    assertEquals(strip(byShard.headers), strip(byEgress.headers), "identical headers");
    assert(!/[0-9a-f]{32,}/i.test(shardText + egressText), "no digest on the wire");

    const freshGuess = supabaseBearer("fresh-guess");
    respondWith(h, (call) =>
      isUserCall(call) && bearerOfCall(call) === freshGuess ? badJwt() : null,
    );
    const refusal = await h.handler(userRequest("GET", "/v1/me", { token: freshGuess, ip }));
    const refusalText = await refusal.text();
    assertEquals(refusal.status, 401);
    assert(!/liveness|credential|shard|stuffing/i.test(refusalText), "no classification");
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ATTACK 8 — boundary values: degenerate bearers and refresh bodies must be
// local refusals (charge nothing) and never gate a peer.
// ═════════════════════════════════════════════════════════════════════════════

Deno.test(
  "HOLDS 8 (route): degenerate credentials — 'Bearer' with only whitespace, 16 KiB junk, lowercase scheme, a 4096-char and a 4097-char refresh token — charge nothing and a peer behind the same egress keeps reading",
  async () => {
    const h = await loadHarness();
    h.tables.profiles = [profile(TEST_USER_ID)];
    const ip = freshIp();
    respondWith(h, (call) => (isRefreshCall(call) ? mintedSession(OTHER_USER_ID) : null));
    const peer = fakeSupabaseAccessToken(TEST_USER_ID);
    assertEquals((await readMe(h.handler, ip, peer)).status, 200);

    const mark = h.calls.length;
    const raw = (authorization: string) =>
      send(
        h.handler,
        new Request("http://edge.test/functions/v1/api/v1/me", {
          headers: { "x-forwarded-for": ip, Authorization: authorization },
        }),
      );
    const degenerate: Array<[string, () => Promise<Response>, number]> = [
      ["whitespace bearer", () => raw("Bearer    "), 401],
      ["16 KiB junk", () => raw(`Bearer ${"x".repeat(16_384)}`), 401],
      ["lowercase scheme", () => raw(`bearer ${peer}`), 401],
      ["junk with dots", () => raw("Bearer a.b.c"), 401],
      [
        "4097-char refresh token",
        () => send(h.handler, refreshRequest(ip, "r".repeat(4_097), peer)),
        400,
      ],
    ];
    for (const [label, run, expected] of degenerate) {
      for (let i = 0; i < 8; i += 1) {
        assertEquals((await run()).status, expected, label);
      }
    }
    assertEquals(authCallsSince(h, mark).length, 0, "none reached Auth");
    assertEquals(await egressCharged(ip), 0, "none charged");
    // A 4096-char refresh token is judged (and here rotated).
    assertEquals((await send(h.handler, refreshRequest(ip, "r".repeat(4_096), peer))).status, 200);
    assertEquals((await readMe(h.handler, ip, peer)).status, 200, "peer still reads");
  },
);
