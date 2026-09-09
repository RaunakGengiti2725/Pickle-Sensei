// W11-01 adversarial attacks on the auth-failure budget behind a shared NAT
// egress (candidate 96a0f658, branch devin/pp/w11-01/impl-r7-c2).
//
// Each test is one attack at a failure boundary of rateLimit.ts +
// the index.ts wiring, run through the REAL handler (routesHarness) or the
// module isolates (harness.ts). Assertions state the behaviour the package
// objective / the module's own contract promise, so a failing test here IS
// the reproduction of a break — nothing in this file is weakened to pass.
//
// Attack categories covered (see the test names):
//   1. network failure at each step on an already-refused credential
//      (429 + Retry-After, 5xx, 3xx, malformed 2xx, timeout)
//   2. concurrency/reentrancy — reservation leak across outages; first-seen
//      parallel burst of ONE credential
//   3. boundary values — exact hold threshold, mixed refusal kinds,
//      Retry-After / RateLimit-Remaining on a hold, window boundary
//   4. replay & duplicate identities — whitespace variants of one credential,
//      mutated variants of one forged credential
//   5. edge-decided refusal (deletion-status capability as bearer) charging
//      the stuffing signal without any Auth judgment
//   6. residual per-egress lockout through sibling budgets
//      (auth_refresh / auth_bootstrap) with zero Auth calls
//   7. corrupt/partial persisted state in Redis (non-integer, negative,
//      float, huge, short replies; per-command write errors with reads intact)
//   8. process death and restart with Redis (shards survive, reservations
//      do not)
//   9. interleaved account switch on one egress
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json w11_01_attack_nat_budget.test.ts

import { assert, assertEquals } from "@std/assert";
import { peekRateLimit } from "../rateLimit.ts";
import { configureRedis, fakeUpstash, loadIsolate, sleep } from "./harness.ts";
import {
  fakeGoogleIdToken,
  fakeSupabaseAccessToken,
  type Harness,
  loadHarness,
  type RecordedCall,
  SUPABASE_URL,
  userRequest,
} from "./routesHarness.ts";

/** Mirrors AUTH_FAILURE_LIMIT / AUTH_REFRESH_LIMIT / AUTH_BOOTSTRAP_LIMIT in index.ts. */
const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
const AUTH_REFRESH_LIMIT = { limit: 30, windowSeconds: 60 };
const AUTH_BOOTSTRAP_LIMIT = { limit: 30, windowSeconds: 60 };
const VENUE_USER = "33333333-3333-4333-8333-333333333333";
const OTHER_USER = "66666666-6666-4666-8666-666666666666";
const PROBE_ROUTE = "/v1/me/saved-drills";

let ipCounter = 0;
const freshIp = (): string => {
  ipCounter += 1;
  return `10.61.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
};

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const bearerOfCall = (call: RecordedCall): string =>
  (call.headers.authorization ?? "").replace(/^Bearer /, "");
const isUserCall = (call: RecordedCall): boolean =>
  call.url.startsWith(`${SUPABASE_URL}/auth/v1/user`);
const isRefreshCall = (call: RecordedCall): boolean =>
  call.url.startsWith(`${SUPABASE_URL}/auth/v1/token`) &&
  call.url.includes("grant_type=refresh_token");
const isIdTokenCall = (call: RecordedCall): boolean =>
  call.url.startsWith(`${SUPABASE_URL}/auth/v1/token`) && call.url.includes("grant_type=id_token");
const isAuthCall = (call: RecordedCall): boolean => call.url.startsWith(`${SUPABASE_URL}/auth/v1/`);

const bodyField = (call: RecordedCall, field: string): string => {
  const body = call.body;
  if (!body || typeof body !== "object") return "";
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
};

const userCallsFor = (h: Harness, bearer: string): number =>
  h.calls.filter((call) => isUserCall(call) && bearerOfCall(call) === bearer).length;
const refreshCallsFor = (h: Harness, token: string): number =>
  h.calls.filter((call) => isRefreshCall(call) && bodyField(call, "refresh_token") === token)
    .length;

/** Upstream answer for one credential; `null` = the harness default (valid). */
type Upstream = (() => Response | Promise<Response>) | null;

interface AuthFakes {
  bearers: Map<string, Upstream>;
  refreshTokens: Map<string, Upstream>;
  idTokens: Map<string, Upstream>;
}

const badJwt = (): Response =>
  jsonResponse(401, {
    code: 401,
    error_code: "bad_jwt",
    msg: "invalid JWT: unable to parse or verify signature",
  });
const sessionGone = (): Response =>
  jsonResponse(403, {
    code: 403,
    error_code: "session_not_found",
    msg: "Session from session_id claim in JWT does not exist",
  });
const refreshNotFound = (): Response =>
  jsonResponse(400, {
    error: "invalid_grant",
    error_description: "Invalid Refresh Token: Refresh Token Not Found",
    error_code: "refresh_token_not_found",
  });
const badIdToken = (): Response =>
  jsonResponse(400, {
    error: "invalid_grant",
    error_description: "Bad ID token",
    error_code: "bad_id_token",
  });

function installAuth(h: Harness): AuthFakes {
  const fakes: AuthFakes = { bearers: new Map(), refreshTokens: new Map(), idTokens: new Map() };
  h.respond = (call) => {
    if (isUserCall(call)) return fakes.bearers.get(bearerOfCall(call))?.() ?? null;
    if (isRefreshCall(call)) {
      return fakes.refreshTokens.get(bodyField(call, "refresh_token"))?.() ?? null;
    }
    if (isIdTokenCall(call)) return fakes.idTokens.get(bodyField(call, "id_token"))?.() ?? null;
    return null;
  };
  return fakes;
}

async function probe(
  h: Harness,
  ip: string,
  bearer: string,
  rawAuthorization?: string,
): Promise<Response> {
  const request = userRequest("GET", PROBE_ROUTE, { token: bearer, ip });
  if (rawAuthorization !== undefined) request.headers.set("Authorization", rawAuthorization);
  const response = await h.handler(request);
  await response.body?.cancel();
  return response;
}

async function refresh(h: Harness, ip: string, body: unknown): Promise<Response> {
  const request = new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
    method: "POST",
    headers: { "x-forwarded-for": ip, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await h.handler(request);
  await response.body?.cancel();
  return response;
}

async function bootstrap(h: Harness, ip: string, idToken: string, user = VENUE_USER) {
  h.tables.profiles = [
    { id: user, email: "venue@example.com", provider: "google", onboarding_state: "complete" },
  ];
  const response = await h.handler(
    userRequest("POST", "/v1/account/bootstrap", { token: idToken, ip, body: {} }),
  );
  await response.body?.cancel();
  return response;
}

const forgedBearer = (tag: string): string =>
  fakeSupabaseAccessToken(
    "44444444-4444-4444-8444-444444444444",
    `${crypto.randomUUID()}-forged-${tag}`,
  );

async function egressCharged(ip: string): Promise<number> {
  const window = await peekRateLimit(
    "authfail",
    ip,
    AUTH_FAILURE_LIMIT.limit,
    AUTH_FAILURE_LIMIT.windowSeconds,
  );
  return window.limit - window.remaining;
}

function retryAfterOf(response: Response): number {
  return Number(response.headers.get("Retry-After"));
}

/** A string that index.ts recognises as an account-deletion status capability
 * (43 URL-safe chars, last one from the base64url final-sextet alphabet). */
function capabilityShaped(seed: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let value = "";
  let x = seed * 2654435761 + 12345;
  for (let i = 0; i < 42; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    value += alphabet[x % alphabet.length];
  }
  return `${value}A`;
}

// ─── 1. network failure at each step ─────────────────────────────────────────

Deno.test(
  "ATTACK network: 429+Retry-After, 5xx, 3xx, malformed 2xx and a timeout from Auth on an already-refused bearer and refresh token are 503s that charge nothing and are all judged (never fast-failed)",
  async () => {
    const h = await loadHarness();
    const auth = installAuth(h);
    const ip = freshIp();
    const tag = crypto.randomUUID();
    const bearer = fakeSupabaseAccessToken(VENUE_USER, `dead-${tag}`);
    const refreshToken = `dead-refresh-${tag}`;
    auth.bearers.set(bearer, sessionGone);
    auth.refreshTokens.set(refreshToken, refreshNotFound);
    assertEquals((await probe(h, ip, bearer)).status, 401, "one liveness refusal on record");
    assertEquals((await refresh(h, ip, { refreshToken })).status, 401);

    const hangs: Promise<unknown>[] = [];
    const hang = (): Promise<Response> => {
      const late = sleep(450).then(() => jsonResponse(200, { id: VENUE_USER }));
      hangs.push(late);
      return late;
    };
    const failures: Array<[string, Upstream]> = [
      ["429 + Retry-After", () => jsonResponse(429, { msg: "over quota" }, { "Retry-After": "7" })],
      ["500", () => jsonResponse(500, { msg: "boom" })],
      ["502 html", () => new Response("<html>bad gateway</html>", { status: 502 })],
      ["302 redirect", () => new Response(null, { status: 302, headers: { Location: "/x" } })],
      ["malformed 2xx", () => new Response("<html>gateway page</html>", { status: 200 })],
      ["2xx without id", () => jsonResponse(200, { unexpected: true })],
      ["timeout", hang],
    ];
    Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "200");
    try {
      let bearerJudgments = userCallsFor(h, bearer);
      let refreshJudgments = refreshCallsFor(h, refreshToken);
      for (const [label, upstream] of failures) {
        auth.bearers.set(bearer, upstream);
        auth.refreshTokens.set(refreshToken, upstream);
        const bearerAnswer = await probe(h, ip, bearer);
        assertEquals(bearerAnswer.status, 503, `${label}: bearer → retryable 503`);
        assert(retryAfterOf(bearerAnswer) >= 1, `${label}: 503 carries Retry-After`);
        const refreshAnswer = await refresh(h, ip, { refreshToken });
        assertEquals(refreshAnswer.status, 503, `${label}: refresh → retryable 503`);
        assert(retryAfterOf(refreshAnswer) >= 1, `${label}: refresh 503 carries Retry-After`);
        if (label === "429 + Retry-After") {
          assertEquals(retryAfterOf(bearerAnswer), 7, "upstream Retry-After is forwarded");
          assertEquals(retryAfterOf(refreshAnswer), 7);
        }
        bearerJudgments += 1;
        refreshJudgments += 1;
        assertEquals(userCallsFor(h, bearer), bearerJudgments, `${label}: bearer reached Auth`);
        assertEquals(
          refreshCallsFor(h, refreshToken),
          refreshJudgments,
          `${label}: refresh reached Auth`,
        );
      }
    } finally {
      Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
      await Promise.all(hangs);
    }
    assertEquals(await egressCharged(ip), 0, "outages never charge the stuffing signal");
    // The shard holds exactly the two liveness refusals Auth issued: a
    // co-tenant's valid credentials on the same egress are untouched.
    const venue = fakeSupabaseAccessToken(VENUE_USER, `venue-${tag}`);
    assertEquals((await probe(h, ip, venue)).status, 200);
    assertEquals((await refresh(h, ip, { refreshToken: `venue-refresh-${tag}` })).status, 200);
  },
);

// ─── 2. concurrency / reentrancy ─────────────────────────────────────────────

Deno.test(
  "ATTACK reservation leak: 29 Auth outages after ONE refusal hold the credential (429) although Auth refused it exactly once — an outage must charge nothing, so the next presentation must be judged (401)",
  async () => {
    const h = await loadHarness();
    const auth = installAuth(h);
    const ip = freshIp();
    const tag = crypto.randomUUID();
    const bearer = fakeSupabaseAccessToken(VENUE_USER, `leak-${tag}`);
    auth.bearers.set(bearer, sessionGone);
    assertEquals((await probe(h, ip, bearer)).status, 401, "one liveness refusal on record");

    auth.bearers.set(bearer, () => jsonResponse(503, { message: "upstream unavailable" }));
    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit - 1; i += 1) {
      assertEquals((await probe(h, ip, bearer)).status, 503, `outage ${i} is retryable`);
    }
    assertEquals(await egressCharged(ip), 0);

    auth.bearers.set(bearer, sessionGone);
    const recovered = await probe(h, ip, bearer);
    assertEquals(
      recovered.status,
      401,
      `after Auth recovers a once-refused credential is judged again, not held (got ${recovered.status}, Retry-After ${
        recovered.headers.get("Retry-After")
      })`,
    );
    assertEquals(
      userCallsFor(h, bearer),
      AUTH_FAILURE_LIMIT.limit + 1,
      "Auth judged every presentation",
    );
  },
);

Deno.test(
  "ATTACK first-seen burst: 200 parallel presentations of ONE never-seen forged bearer are bounded like a sequence of them (≤ 30 Auth judgments), as admitAuthCredential promises",
  async () => {
    const h = await loadHarness();
    const auth = installAuth(h);
    const ip = freshIp();
    const tag = crypto.randomUUID();

    // Control: the same 200 presentations in SEQUENCE → 30 judgments, 170 holds.
    const sequential = forgedBearer(`${tag}-seq`);
    auth.bearers.set(sequential, badJwt);
    const sequentialStatuses: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      sequentialStatuses.push((await probe(h, ip, sequential)).status);
    }
    assertEquals(sequentialStatuses.filter((s) => s === 401).length, AUTH_FAILURE_LIMIT.limit);
    assertEquals(sequentialStatuses.filter((s) => s === 429).length, 170);
    assertEquals(userCallsFor(h, sequential), AUTH_FAILURE_LIMIT.limit, "sequence: 30 judgments");

    const burst = forgedBearer(`${tag}-burst`);
    auth.bearers.set(burst, badJwt);
    const statuses = (await Promise.all(
      Array.from({ length: 200 }, () => probe(h, ip, burst)),
    )).map((r) => r.status);
    assert(statuses.every((s) => s === 401 || s === 429), `only 401/429: ${new Set(statuses)}`);
    const judged = userCallsFor(h, burst);
    assert(
      judged <= AUTH_FAILURE_LIMIT.limit,
      `a parallel burst of one forged credential reached Auth ${judged}× (sequence: ${AUTH_FAILURE_LIMIT.limit}×)`,
    );
  },
);

// ─── 3. boundary values ──────────────────────────────────────────────────────

Deno.test(
  "ATTACK boundary: the 30th presentation of a refused credential is still judged, the 31st is held; liveness + credential refusals add up; the hold carries Retry-After ≤ window and RateLimit-Remaining 0; the hold ends exactly at the window boundary",
  async () => {
    const h = await loadHarness();
    const auth = installAuth(h);
    const ip = freshIp();
    const tag = crypto.randomUUID();
    const realNow = Date.now;
    try {
      const windowMs = AUTH_FAILURE_LIMIT.windowSeconds * 1_000;
      const boundary = Math.floor(realNow() / windowMs) * windowMs + windowMs;
      let now = boundary - 30_000;
      Date.now = () => now;

      const forged = forgedBearer(`${tag}-edge`);
      auth.bearers.set(forged, badJwt);
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit - 1; i += 1) {
        assertEquals((await probe(h, ip, forged)).status, 401, `refusal ${i + 1}`);
      }
      assertEquals((await probe(h, ip, forged)).status, 401, "the 30th presentation is judged");
      assertEquals(userCallsFor(h, forged), AUTH_FAILURE_LIMIT.limit);
      const held = await probe(h, ip, forged);
      assertEquals(held.status, 429, "the 31st is held");
      assertEquals(held.headers.get("RateLimit-Remaining"), "0");
      assert(
        retryAfterOf(held) >= 1 && retryAfterOf(held) <= 30,
        `Retry-After ${retryAfterOf(held)}`,
      );
      assertEquals(userCallsFor(h, forged), AUTH_FAILURE_LIMIT.limit, "no Auth call while held");

      // Mixed kinds on ONE credential from a quiet egress: 15 liveness + 15
      // credential refusals.
      const quietIp = freshIp();
      const mixed = fakeSupabaseAccessToken(VENUE_USER, `mixed-${tag}`);
      auth.bearers.set(mixed, sessionGone);
      for (let i = 0; i < 15; i += 1) assertEquals((await probe(h, quietIp, mixed)).status, 401);
      auth.bearers.set(mixed, badJwt);
      for (let i = 0; i < 15; i += 1) assertEquals((await probe(h, quietIp, mixed)).status, 401);
      assertEquals(
        (await probe(h, quietIp, mixed)).status,
        429,
        "both kinds count toward the hold",
      );
      assertEquals(await egressCharged(quietIp), 15, "only credential refusals are stuffing");

      // Boundary: one ms before the window turns the hold is intact; at the
      // boundary the shard is a new window and Auth judges again.
      now = boundary - 1;
      assertEquals((await probe(h, ip, forged)).status, 429);
      now = boundary;
      assertEquals((await probe(h, ip, forged)).status, 401, "a new window is judged");
      assertEquals(userCallsFor(h, forged), AUTH_FAILURE_LIMIT.limit + 1);
    } finally {
      Date.now = realNow;
    }
  },
);

Deno.test(
  "ATTACK boundary: a credential fast-failed by a saturated egress answers 429 with RateLimit-Remaining 0 (a 429 must not advertise remaining budget)",
  async () => {
    const h = await loadHarness();
    const auth = installAuth(h);
    const ip = freshIp();
    const tag = crypto.randomUUID();
    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
      const junk = forgedBearer(`${tag}-${i}`);
      auth.bearers.set(junk, badJwt);
      assertEquals((await probe(h, ip, junk)).status, 401);
    }
    assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit, "egress saturated");
    const once = forgedBearer(`${tag}-once`);
    auth.bearers.set(once, badJwt);
    assertEquals((await probe(h, ip, once)).status, 401, "probation: judged once");
    const fastFailed = await probe(h, ip, once);
    assertEquals(fastFailed.status, 429, "second look is fast-failed");
    assertEquals(userCallsFor(h, once), 1);
    assertEquals(fastFailed.headers.get("RateLimit-Limit"), String(AUTH_FAILURE_LIMIT.limit));
    assertEquals(
      fastFailed.headers.get("RateLimit-Remaining"),
      "0",
      `a 429 advertising remaining budget contradicts itself (Retry-After ${
        retryAfterOf(fastFailed)
      })`,
    );
  },
);

// ─── 4. replay & duplicate identities ────────────────────────────────────────

Deno.test(
  "ATTACK duplicate identities: whitespace variants of one forged bearer are ONE shard (Auth sees the trimmed token) and a tab-separated scheme is a local refusal that charges nothing",
  async () => {
    const h = await loadHarness();
    const auth = installAuth(h);
    const ip = freshIp();
    const tag = crypto.randomUUID();
    const forged = forgedBearer(`${tag}-ws`);
    auth.bearers.set(forged, badJwt);
    const variants = [
      `Bearer ${forged}`,
      `Bearer  ${forged}`,
      `Bearer ${forged} `,
      `Bearer ${forged}\t`,
      `Bearer \u00A0${forged}\u00A0`,
    ];
    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
      const raw = variants[i % variants.length];
      assertEquals((await probe(h, ip, forged, raw)).status, 401, `variant ${i} judged`);
    }
    assertEquals(
      userCallsFor(h, forged),
      AUTH_FAILURE_LIMIT.limit,
      "Auth always saw the trimmed token",
    );
    for (const raw of variants) {
      assertEquals(
        (await probe(h, ip, forged, raw)).status,
        429,
        `held for ${JSON.stringify(raw)}`,
      );
    }
    assertEquals(userCallsFor(h, forged), AUTH_FAILURE_LIMIT.limit, "no Auth call while held");

    const before = await egressCharged(ip);
    assertEquals(
      (await probe(h, ip, forged, `Bearer\t${forged}`)).status,
      401,
      "tab scheme: local 401",
    );
    assertEquals(
      (await probe(h, ip, forged, `bearer ${forged}`)).status,
      401,
      "lowercase scheme: local 401",
    );
    assertEquals(await egressCharged(ip), before, "local refusals are not stuffing");
    assertEquals(userCallsFor(h, forged), AUTH_FAILURE_LIMIT.limit, "…and never reach Auth");
  },
);

Deno.test(
  "ATTACK mutation (characterisation of the documented non-claim): 31 mutated variants of one forged bearer from one egress are each judged by Auth — the per-credential hold does not bound an attacker who varies the credential",
  async () => {
    const h = await loadHarness();
    const auth = installAuth(h);
    const ip = freshIp();
    const tag = crypto.randomUUID();
    const base = forgedBearer(`${tag}-mut`);
    const statuses: number[] = [];
    for (let i = 0; i <= AUTH_FAILURE_LIMIT.limit; i += 1) {
      const variant = `${base}${"=".repeat(i)}`;
      auth.bearers.set(variant, badJwt);
      statuses.push((await probe(h, ip, variant)).status);
    }
    const judged = statuses.filter((s) => s === 401).length;
    assert(
      statuses.every((s) => s === 401 || s === 429),
      `only 401/429 expected: ${statuses.join(",")}`,
    );
    // Documented in rateLimit_nat_budget.test.ts: DISTINCT credentials are
    // bounded only by IP_LIMIT and Auth's own limits, not by the auth-failure
    // budget. Pin the observed amplification so the reviewer sees the number.
    assertEquals(
      judged,
      AUTH_FAILURE_LIMIT.limit + 1,
      `every mutated variant reached Auth (statuses ${statuses.join(",")})`,
    );
    assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit, "egress signal saturated");
    // A valid co-tenant bearer is still judged and served.
    assertEquals((await probe(h, ip, fakeSupabaseAccessToken(VENUE_USER, `v-${tag}`))).status, 200);
  },
);

// ─── 5. edge-decided refusal charging the stuffing signal ────────────────────

Deno.test(
  "ATTACK edge-decided refusal: 30 deletion-status-capability-shaped bearers are refused at this edge with ZERO Auth calls — chargeAuthFailure's contract ('never for refusals decided at this edge') says they must not saturate the egress stuffing signal",
  async () => {
    const h = await loadHarness();
    const auth = installAuth(h);
    const ip = freshIp();
    const tag = crypto.randomUUID();
    const authCallsBefore = h.calls.filter(isAuthCall).length;
    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
      const capability = capabilityShaped(ipCounter * 1_000 + i);
      const answer = await probe(h, ip, capability);
      assertEquals(answer.status, 401, `capability ${i} is refused locally`);
    }
    assertEquals(h.calls.filter(isAuthCall).length, authCallsBefore, "Auth was never consulted");
    const charged = await egressCharged(ip);
    // Consequence if the signal IS charged: a co-tenant credential refused
    // once as a credential is fast-failed on its second look although the
    // egress never produced a single Auth-judged credential refusal.
    const once = forgedBearer(`${tag}-cotenant`);
    auth.bearers.set(once, badJwt);
    assertEquals((await probe(h, ip, once)).status, 401);
    const secondLook = await probe(h, ip, once);
    assertEquals(
      charged,
      0,
      `edge-decided refusals charged the stuffing signal ${charged}× without Auth; co-tenant second look → ${secondLook.status}`,
    );
    assertEquals(secondLook.status, 401);
  },
);

// ─── 6. residual per-egress lockout through sibling budgets ──────────────────

Deno.test(
  "ATTACK residual NAT lockout: 30 malformed refresh bodies (400, no Auth call) from one egress lock out a co-tenant's VALID refresh for the minute; 30 forged ID tokens lock out a co-tenant's VALID sign-in — one NAT egress can still lock out a venue",
  async () => {
    const h = await loadHarness();
    const auth = installAuth(h);
    const ip = freshIp();
    const tag = crypto.randomUUID();
    const authCallsBefore = h.calls.filter(isAuthCall).length;
    for (let i = 0; i < AUTH_REFRESH_LIMIT.limit; i += 1) {
      assertEquals((await refresh(h, ip, {})).status, 400, `garbage refresh ${i}`);
    }
    assertEquals(h.calls.filter(isAuthCall).length, authCallsBefore, "garbage never reached Auth");
    assertEquals(await egressCharged(ip), 0, "…and is not stuffing");
    const venueRefresh = await refresh(h, ip, { refreshToken: `venue-refresh-${tag}` });
    assertEquals(
      venueRefresh.status,
      200,
      `co-tenant's valid refresh is locked out (got ${venueRefresh.status}, Retry-After ${
        venueRefresh.headers.get("Retry-After")
      })`,
    );

    const ip2 = freshIp();
    for (let i = 0; i < AUTH_BOOTSTRAP_LIMIT.limit; i += 1) {
      const idToken = fakeGoogleIdToken(`7777${crypto.randomUUID().slice(4)}`);
      auth.idTokens.set(idToken, badIdToken);
      assertEquals((await bootstrap(h, ip2, idToken)).status, 401, `forged sign-in ${i}`);
    }
    const venueSignIn = await bootstrap(h, ip2, fakeGoogleIdToken(VENUE_USER));
    assertEquals(
      venueSignIn.status,
      200,
      `co-tenant's valid sign-in is locked out (got ${venueSignIn.status}, Retry-After ${
        venueSignIn.headers.get("Retry-After")
      })`,
    );
  },
);

// ─── 7. corrupt / partial persisted state (Redis) ────────────────────────────

Deno.test(
  "ATTACK corrupt Redis state: non-integer, negative, float, huge and NaN shard/egress values, per-command INCR errors and short pipeline replies never throw, never hold a valid credential, and the replay hold still lands through the memory fallback",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const { rateLimit } = await loadIsolate();
      const ip = freshIp();
      const bucket = Math.floor(Date.now() / (AUTH_FAILURE_LIMIT.windowSeconds * 1_000));
      const credential = `corrupt-${crypto.randomUUID()}`;
      const identity = await rateLimit.authFailureIdentity(credential);
      const credKey = `rl:authfail_cred:${bucket}:${identity}`;
      const liveKey = `rl:authfail_live:${bucket}:${identity}`;
      const egressKey = `rl:authfail:${bucket}:${ip}`;
      const corruptValues = ["garbage", "-5", "1.5", "1e400", "NaN", "9007199254740993", "", "[]"];
      for (const value of corruptValues) {
        redis.store.set(credKey, { value, expiresAtMs: null });
        redis.store.set(liveKey, { value, expiresAtMs: null });
        redis.store.set(egressKey, { value, expiresAtMs: null });
        const admitted = await rateLimit.admitAuthCredential(ip, credential, AUTH_FAILURE_LIMIT);
        assertEquals(admitted.allowed, true, `corrupt value ${JSON.stringify(value)} holds nobody`);
        assertEquals(
          (await rateLimit.peekAuthFailureBudget(ip, `other-${value}`, AUTH_FAILURE_LIMIT)).allowed,
          true,
        );
      }
      // INCR on the corrupt shard: the fake stores NaN → Upstash-style
      // unusable reply; the charge must fall back to memory and still count.
      redis.store.set(credKey, { value: "garbage", expiresAtMs: null });
      redis.store.delete(egressKey);
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        const charged = await rateLimit.chargeAuthFailure(
          ip,
          credential,
          "credential",
          AUTH_FAILURE_LIMIT,
        );
        assert(Number.isFinite(charged.remaining), `charge ${i} returns a finite window`);
      }
      assertEquals(
        (await rateLimit.peekAuthFailureBudget(ip, credential, AUTH_FAILURE_LIMIT)).allowed,
        false,
        "30 refusals recorded through the fallback hold the credential",
      );
      // Short pipeline replies on a clean key.
      const short = `short-${crypto.randomUUID()}`;
      redis.truncateRepliesTo = 1;
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        await rateLimit.chargeAuthFailure(ip, short, "credential", AUTH_FAILURE_LIMIT);
      }
      redis.truncateRepliesTo = null;
      assertEquals(
        (await rateLimit.peekAuthFailureBudget(ip, short, AUTH_FAILURE_LIMIT)).allowed,
        false,
        "short replies: memory holds the replayed credential",
      );
      assertEquals(
        (await rateLimit.peekAuthFailureBudget(
          ip,
          `valid-${crypto.randomUUID()}`,
          AUTH_FAILURE_LIMIT,
        ))
          .allowed,
        true,
        "a never-refused credential is admitted throughout",
      );
    } finally {
      redis.restore();
      configureRedis(false);
    }
  },
);

Deno.test(
  "ATTACK partial Redis failure: writes rejected per command (READONLY replica / quota) while reads succeed — 30 refusals of one credential are recorded in memory but the replayed credential is never held because the successful Redis GET (0) masks the memory fallback",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const { rateLimit } = await loadIsolate();
      const ip = freshIp();
      const replayed = `readonly-${crypto.randomUUID()}`;
      redis.commandError = (cmd) =>
        String(cmd[0]).toUpperCase() === "INCR"
          ? "READONLY You can't write against a read only replica."
          : null;
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        const charged = await rateLimit.chargeAuthFailure(
          ip,
          replayed,
          "credential",
          AUTH_FAILURE_LIMIT,
        );
        assertEquals(
          charged.remaining,
          AUTH_FAILURE_LIMIT.limit - (i + 1),
          `charge ${i + 1} is recorded (memory fallback)`,
        );
      }
      const held = await rateLimit.admitAuthCredential(ip, replayed, AUTH_FAILURE_LIMIT);
      assertEquals(
        held.allowed,
        false,
        `30 recorded refusals must hold the credential (remaining ${held.remaining})`,
      );
    } finally {
      redis.restore();
      configureRedis(false);
    }
  },
);

// ─── 8. process death and restart (Redis) ────────────────────────────────────

Deno.test(
  "ATTACK restart: a fresh isolate holds what Redis recorded, its lost reservations bound a parallel replay burst by the shared count, and a never-refused credential is admitted",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const dying = await loadIsolate();
      const ip = freshIp();
      const held = `held-${crypto.randomUUID()}`;
      const once = `once-${crypto.randomUUID()}`;
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        await dying.rateLimit.chargeAuthFailure(ip, held, "credential", AUTH_FAILURE_LIMIT);
      }
      await dying.rateLimit.chargeAuthFailure(ip, once, "liveness", AUTH_FAILURE_LIMIT);
      // Reservations taken by the dying isolate vanish with it.
      for (let i = 0; i < 10; i += 1) {
        await dying.rateLimit.admitAuthCredential(ip, once, AUTH_FAILURE_LIMIT);
      }

      const restarted = await loadIsolate();
      assertEquals(
        (await restarted.rateLimit.admitAuthCredential(ip, held, AUTH_FAILURE_LIMIT)).allowed,
        false,
        "the shared record survives the restart",
      );
      const admitted = await Promise.all(
        Array.from(
          { length: 80 },
          () => restarted.rateLimit.admitAuthCredential(ip, once, AUTH_FAILURE_LIMIT),
        ),
      );
      const judged = admitted.filter((r) => r.allowed).length;
      assert(
        judged <= AUTH_FAILURE_LIMIT.limit - 1,
        `after restart a burst of a once-refused credential got ${judged} judgments`,
      );
      assertEquals(
        (await restarted.rateLimit.admitAuthCredential(
          ip,
          `fresh-${crypto.randomUUID()}`,
          AUTH_FAILURE_LIMIT,
        ))
          .allowed,
        true,
      );
    } finally {
      redis.restore();
      configureRedis(false);
    }
  },
);

// ─── 9. interleaved account switch ───────────────────────────────────────────

Deno.test(
  "ATTACK account switch: user A's held dead bearer on one egress leaves user B's bearer, refresh and sign-in at 200, and A's fresh sign-in on the same egress is judged and served",
  async () => {
    const h = await loadHarness();
    const auth = installAuth(h);
    const ip = freshIp();
    const tag = crypto.randomUUID();
    const deadA = fakeSupabaseAccessToken(VENUE_USER, `A-dead-${tag}`);
    auth.bearers.set(deadA, sessionGone);
    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
      assertEquals((await probe(h, ip, deadA)).status, 401);
    }
    assertEquals((await probe(h, ip, deadA)).status, 429, "A's dead bearer is held");

    const bearerB = fakeSupabaseAccessToken(OTHER_USER, `B-${tag}`);
    assertEquals((await probe(h, ip, bearerB)).status, 200, "B's bearer");
    assertEquals(
      (await refresh(h, ip, { refreshToken: `B-refresh-${tag}` })).status,
      200,
      "B's refresh",
    );
    assertEquals(
      (await bootstrap(h, ip, fakeGoogleIdToken(OTHER_USER), OTHER_USER)).status,
      200,
      "B's sign-in",
    );
    assertEquals(
      (await bootstrap(h, ip, fakeGoogleIdToken(VENUE_USER))).status,
      200,
      "A signs in again",
    );
    assertEquals(
      (await probe(h, ip, fakeSupabaseAccessToken(VENUE_USER, `A-new-${tag}`))).status,
      200,
    );
    assertEquals((await probe(h, ip, deadA)).status, 429, "…while the dead bearer stays held");
    assertEquals(await egressCharged(ip), 0, "liveness only: no stuffing recorded");
  },
);
