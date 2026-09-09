// W11-01 adversarial tests — the real edge handler (routesHarness, memory
// fallback, fake Supabase Auth) attacked at the boundaries the candidate's
// own regression file (rateLimit_nat_budget.test.ts) does not exercise:
// parallel replay of ONE forged credential, an account switch under
// saturation, a minted token presented under the wrong grant, boundary
// credential shapes, and Auth answering with shapes that are NOT verdicts
// (429, redirect, HTML, empty refusal bodies).
//
// Each Deno.test is one attack. Attacks the candidate survives assert the
// surviving behaviour; attacks that break it assert the CORRECT behaviour and
// therefore fail on the candidate (see the [break] tags).
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check \
//     --config deno.json attack_w11_01_nat_budget.test.ts

import { assert, assertEquals } from "@std/assert";
import { peekRateLimit } from "../rateLimit.ts";
import {
  fakeSupabaseAccessToken,
  loadHarness,
  type RecordedCall,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
const MAX_REFRESH_TOKEN_LENGTH = 4_096;

type Handler = (request: Request) => Promise<Response>;

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwtOf = (payload: Record<string, unknown>): string =>
  `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.sig`;
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
const googleIdToken = (sub: string): string =>
  jwtOf({
    iss: "https://accounts.google.com",
    sub,
    exp: Math.floor(Date.now() / 1000) + 3600,
    salt: crypto.randomUUID(),
  });

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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
const refreshNotFound = () =>
  jsonResponse(400, {
    error: "invalid_grant",
    error_description: "Invalid Refresh Token: Refresh Token Not Found",
    error_code: "refresh_token_not_found",
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
  (call.headers.authorization ?? "").replace(/^Bearer /, "").trim();
const isUserCall = (call: RecordedCall) => call.url.startsWith(`${SUPABASE_URL}/auth/v1/user`);
const isTokenCall = (call: RecordedCall) => call.url.startsWith(`${SUPABASE_URL}/auth/v1/token`);
const isRefreshCall = (call: RecordedCall) =>
  isTokenCall(call) && call.url.includes("grant_type=refresh_token");
const isIdTokenCall = (call: RecordedCall) =>
  isTokenCall(call) && call.url.includes("grant_type=id_token");
const isLogoutCall = (call: RecordedCall) => call.url.startsWith(`${SUPABASE_URL}/auth/v1/logout`);
const isAuthCall = (call: RecordedCall) => call.url.startsWith(`${SUPABASE_URL}/auth/v1/`);
const bodyField = (call: RecordedCall, field: string): string => {
  const body = call.body;
  if (typeof body !== "object" || body === null) return "";
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
};

let ipCounter = 0;
const freshIp = () => `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const egressCharged = async (ip: string): Promise<number> => {
  const window = await peekRateLimit(
    "authfail",
    ip,
    AUTH_FAILURE_LIMIT.limit,
    AUTH_FAILURE_LIMIT.windowSeconds,
  );
  return window.limit - window.remaining;
};

const profile = () => ({
  id: TEST_USER_ID,
  email: "user@example.com",
  onboarding_state: "complete",
  provider: "google",
  skill_level: null,
  handedness: null,
  primary_goal: null,
  biggest_problem: null,
  focus_checkpoint: null,
  first_name: null,
  gender: null,
});

async function send(handler: Handler, request: Request): Promise<Response> {
  const response = await handler(request);
  await response.body?.cancel();
  return response;
}
const readMe = (handler: Handler, ip: string, bearer: string) =>
  send(handler, userRequest("GET", "/v1/me", { token: bearer, ip }));
const refreshRequest = (ip: string, refreshToken: unknown) =>
  new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
    method: "POST",
    headers: { "x-forwarded-for": ip, "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
const postRefresh = (handler: Handler, ip: string, refreshToken: unknown) =>
  send(handler, refreshRequest(ip, refreshToken));
const postLogout = (handler: Handler, ip: string, bearer: string) =>
  send(handler, userRequest("POST", "/v1/auth/logout", { token: bearer, ip, body: {} }));
const postBootstrap = (handler: Handler, ip: string, idToken: string) =>
  send(handler, userRequest("POST", "/v1/account/bootstrap", { token: idToken, ip, body: {} }));

async function sendJson(
  handler: Handler,
  request: Request,
): Promise<{ status: number; body: Record<string, unknown> }> {
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
    body: typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {},
  };
}
const sessionField = (body: Record<string, unknown>, field: string): string => {
  const session = body.session;
  if (typeof session !== "object" || session === null) return "";
  const value = (session as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
};

async function mintHandset(
  handler: Handler,
  ip: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const minted = await sendJson(handler, refreshRequest(ip, `rt-live-${crypto.randomUUID()}`));
  assertEquals(minted.status, 200, "handset signed in");
  const session = {
    accessToken: sessionField(minted.body, "accessToken"),
    refreshToken: sessionField(minted.body, "refreshToken"),
  };
  assert(session.accessToken && session.refreshToken, "the edge handed the handset a session");
  return session;
}

const count = (statuses: number[], status: number) => statuses.filter((s) => s === status).length;
const assertRetryAfterBounded = (response: Response) => {
  const retryAfter = Number(response.headers.get("Retry-After"));
  assert(
    Number.isInteger(retryAfter) &&
      retryAfter >= 1 &&
      retryAfter <= AUTH_FAILURE_LIMIT.windowSeconds,
    `429 must carry a window-bounded Retry-After, got ${retryAfter}`,
  );
};

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

interface AuthSets {
  deadBearers?: Set<string>;
  forgedBearers?: Set<string>;
  deadRefresh?: Set<string>;
  forgedIdTokens?: Set<string>;
  /** Overrides for anything else Auth is asked about. */
  override?: (call: RecordedCall) => Response | null;
}

function installAuth(
  h: { respond: (call: RecordedCall) => Response | null | Promise<Response | null> },
  sets: AuthSets,
) {
  h.respond = (call) => {
    const overridden = sets.override?.(call) ?? null;
    if (overridden) return overridden;
    if (isUserCall(call)) {
      const bearer = bearerOfCall(call);
      if (sets.deadBearers?.has(bearer)) return sessionGone();
      if (sets.forgedBearers?.has(bearer)) return credentialRefused();
      return null;
    }
    if (isRefreshCall(call)) {
      const token = bodyField(call, "refresh_token");
      if (sets.deadRefresh?.has(token)) return refreshNotFound();
      return mintedSession(TEST_USER_ID);
    }
    if (isIdTokenCall(call)) {
      const idToken = bodyField(call, "id_token");
      if (sets.forgedIdTokens?.has(idToken)) {
        return jsonResponse(400, {
          error: "invalid_grant",
          error_description: "Bad ID token",
          error_code: "bad_id_token",
        });
      }
      return mintedSession(TEST_USER_ID);
    }
    return null;
  };
}

async function floodForgedBearers(
  h: { handler: Handler; calls: RecordedCall[] },
  ip: string,
  forgedBearers: Set<string>,
): Promise<void> {
  for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
    const bearer = supabaseBearer(`forged-${i}-${crypto.randomUUID()}`);
    forgedBearers.add(bearer);
    assertEquals((await readMe(h.handler, ip, bearer)).status, 401);
  }
  assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit, "the egress is saturated");
}

// ── Attack 1: concurrency — forty PARALLEL presentations of ONE forged
// bearer (a stuffing script hammering a single guess) behind the venue NAT.
// Nothing is reserved before Auth, so every one of them may reach Auth; the
// question is what that burst does to the venue afterwards. ────────────────
Deno.test(
  "concurrency: forty parallel replays of one forged bearer are bounded to ≤ 40 Auth calls, saturate the egress once, and the venue's minted and dead handsets still pass the gate",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      const ip = freshIp();
      const forgedBearers = new Set<string>();
      const deadBearers = new Set<string>();
      installAuth(h, { forgedBearers, deadBearers });
      h.tables.profiles = [profile()];

      const handset = await mintHandset(h.handler, ip);
      const dead = supabaseBearer("dead-before-burst");
      deadBearers.add(dead);
      assertEquals((await readMe(h.handler, ip, dead)).status, 401, "judged dead once");
      assertEquals(await egressCharged(ip), 0);

      clock.advance(1_000);
      const forged = supabaseBearer("single-guess");
      forgedBearers.add(forged);
      const userCallsBefore = h.calls.filter(isUserCall).length;
      const burst = await Promise.all(
        Array.from({ length: 40 }, () => readMe(h.handler, ip, forged)),
      );
      const statuses = burst.map((r) => r.status);
      assertEquals(
        statuses.every((s) => s === 401 || s === 429),
        true,
        `burst statuses ${statuses.join(",")}`,
      );
      assert(count(statuses, 401) >= 1, "at least one replay was judged by Auth");
      const userCallsDuring = h.calls.filter(isUserCall).length - userCallsBefore;
      assert(
        userCallsDuring <= 40 && userCallsDuring === count(statuses, 401),
        "one Auth call per judged replay",
      );
      const charged = await egressCharged(ip);
      assertEquals(
        charged,
        Math.min(AUTH_FAILURE_LIMIT.limit, userCallsDuring),
        "every judged replay of the same guess charges the egress once, capped at the limit",
      );
      for (const r of burst) if (r.status === 429) assertRetryAfterBounded(r);

      // After the burst the egress is saturated: a novel guess is held, the
      // venue's minted bearer verifies, its refresh rotates and its
      // already-judged dead handset is still told 401 by Auth.
      clock.advance(1_000);
      const held = await readMe(h.handler, ip, supabaseBearer("novel-after-burst"));
      assertEquals(held.status, 429);
      assertEquals((await readMe(h.handler, ip, handset.accessToken)).status, 200);
      assertEquals((await postRefresh(h.handler, ip, handset.refreshToken)).status, 200);
      assertEquals((await readMe(h.handler, ip, dead)).status, 401);
      assertEquals(
        bearerOfCall(h.calls.filter(isUserCall).at(-1)!),
        dead,
        "Auth judged the dead handset",
      );
    });
  },
);

// ── Attack 2: interleaved account switch behind a saturated NAT — a handset
// logs out (its bearer is minted here, so it passes the gate), then replays
// its now-revoked refresh token, then a different person signs in on it. ───
Deno.test(
  "account switch under saturation: logout of a minted session succeeds, the revoked refresh token's replay is a sign-out (401, egress unchanged) and the next sign-in is answered without touching Auth",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      const ip = freshIp();
      const forgedBearers = new Set<string>();
      const deadRefresh = new Set<string>();
      const deadBearers = new Set<string>();
      installAuth(h, { forgedBearers, deadRefresh, deadBearers });
      h.tables.profiles = [profile()];

      const handset = await mintHandset(h.handler, ip);
      clock.advance(1_000);
      await floodForgedBearers(h, ip, forgedBearers);
      const authCallsAfterFlood = h.calls.filter(isAuthCall).length;

      clock.advance(1_000);
      // The user signs out on the handset: the bearer was never verified at
      // this edge (no cache entry), so it must pass the saturated gate.
      const logout = await postLogout(h.handler, ip, handset.accessToken);
      assert(logout.status === 200 || logout.status === 204, `logout status ${logout.status}`);
      assertEquals(h.calls.filter(isLogoutCall).length, 1, "Auth revoked the session");
      assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit, "logout charges nothing");

      // A stale timer on the handset replays the revoked refresh token; Auth
      // no longer knows it. The edge minted it, so this is a sign-out, not a
      // guess: 401 to the app, nothing added to the egress signal.
      deadRefresh.add(handset.refreshToken);
      deadBearers.add(handset.accessToken);
      const replay = await postRefresh(h.handler, ip, handset.refreshToken);
      assertEquals(replay.status, 401, "the app's ONE sign-out signal");
      assertEquals(h.calls.filter(isRefreshCall).length >= 2, true, "Auth judged the replay");
      assertEquals(
        await egressCharged(ip),
        AUTH_FAILURE_LIMIT.limit,
        "a minted token's sign-out is not stuffing",
      );

      // The revoked bearer itself is fenced locally by the logout — no Auth
      // call, no charge.
      const authCallsBeforeFenced = h.calls.filter(isAuthCall).length;
      assertEquals((await readMe(h.handler, ip, handset.accessToken)).status, 401);
      assertEquals(h.calls.filter(isAuthCall).length, authCallsBeforeFenced, "fenced locally");
      assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit);

      // A different person signs in on the same handset: a never-seen ID token
      // behind a saturated egress is held BEFORE Auth (the documented flat-
      // budget behaviour for fresh sign-ins) with a bounded Retry-After.
      const authCallsBeforeSignIn = h.calls.filter(isAuthCall).length;
      const signIn = await postBootstrap(h.handler, ip, googleIdToken("newcomer"));
      assertEquals(signIn.status, 429);
      assertRetryAfterBounded(signIn);
      assertEquals(
        h.calls.filter(isAuthCall).length,
        authCallsBeforeSignIn,
        "no upstream call for a held sign-in",
      );
      assert(h.calls.filter(isAuthCall).length >= authCallsAfterFlood);
    });
  },
);

// ── Attack 3: duplicate identity across grants — a handset's MINTED access
// token is posted as `refreshToken`. Auth answers refresh_token_not_found;
// the registry vouches the string (it minted it as an access token), so the
// refusal is settled as liveness. Thirty of them spend the credential's
// shard — and that shard is keyed by the string, not the grant. ────────────
Deno.test(
  "cross-grant replay: a minted access token posted thirty times as refreshToken is judged each time without charging the egress, the 31st is held, and the same string as a bearer is then held too although Auth accepts it",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      const ip = freshIp();
      const deadRefresh = new Set<string>();
      installAuth(h, { deadRefresh });
      h.tables.profiles = [profile()];

      const handset = await mintHandset(h.handler, ip);
      deadRefresh.add(handset.accessToken);
      clock.advance(60_000); // a fresh minute for the per-IP refresh route budget
      const refreshCallsBefore = h.calls.filter(isRefreshCall).length;
      const replays: number[] = [];
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        replays.push((await postRefresh(h.handler, ip, handset.accessToken)).status);
      }
      assertEquals(count(replays, 401), AUTH_FAILURE_LIMIT.limit, `statuses ${replays.join(",")}`);
      assertEquals(
        h.calls.filter(isRefreshCall).length,
        refreshCallsBefore + AUTH_FAILURE_LIMIT.limit,
      );
      assertEquals(
        await egressCharged(ip),
        0,
        "a minted string's refusal never counts as stuffing",
      );

      clock.advance(1_000);
      const thirtyFirst = await postRefresh(h.handler, ip, handset.accessToken);
      assertEquals(thirtyFirst.status, 429, "the credential's own shard is spent");
      assertRetryAfterBounded(thirtyFirst);
      assertEquals(
        h.calls.filter(isRefreshCall).length,
        refreshCallsBefore + AUTH_FAILURE_LIMIT.limit,
      );

      // The very same string presented under the grant Auth honours: the
      // shard is per credential string, so the valid bearer is held until
      // the window turns — and verifies again as soon as it does.
      const userCallsBefore = h.calls.filter(isUserCall).length;
      const heldBearer = await readMe(h.handler, ip, handset.accessToken);
      assertEquals(heldBearer.status, 429, "the shard holds the string regardless of grant");
      assertEquals(h.calls.filter(isUserCall).length, userCallsBefore, "held before Auth");
      clock.advance(AUTH_FAILURE_LIMIT.windowSeconds * 1_000);
      assertEquals((await readMe(h.handler, ip, handset.accessToken)).status, 200);
      assertEquals(h.calls.filter(isUserCall).length, userCallsBefore + 1);
    });
  },
);

// ── Attack 4: boundary credential shapes on the refresh route — the length
// cap is checked on the RAW string while the identity is TRIMMED. ──────────
Deno.test(
  "boundaries: a 4096-char forged refresh token is judged and charged once, the same token padded past the cap is refused locally with no charge, non-string / empty / whitespace tokens charge nothing, and trimmed variants share one shard",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      const ip = freshIp();
      const deadRefresh = new Set<string>();
      installAuth(h, { deadRefresh });

      const maxToken = `rt-${"x".repeat(MAX_REFRESH_TOKEN_LENGTH - 3)}`;
      assertEquals(maxToken.length, MAX_REFRESH_TOKEN_LENGTH);
      deadRefresh.add(maxToken);
      const judged = await postRefresh(h.handler, ip, maxToken);
      assertEquals(judged.status, 401);
      assertEquals(h.calls.filter(isRefreshCall).length, 1);
      assertEquals(await egressCharged(ip), 1, "one guess, one charge");

      clock.advance(1_000);
      // Padded past the cap: local 400, no Auth call, no charge.
      for (const padded of [` ${maxToken}`, `${maxToken} `, `${maxToken}\n`]) {
        assertEquals((await postRefresh(h.handler, ip, padded)).status, 400);
      }
      for (const junk of [123, null, true, [], {}, "", "   ", "\t\n"]) {
        assertEquals((await postRefresh(h.handler, ip, junk)).status, 400, JSON.stringify(junk));
      }
      assertEquals(h.calls.filter(isRefreshCall).length, 1, "nothing else reached Auth");
      assertEquals(await egressCharged(ip), 1, "local refusals never charge");

      // Trimmed variants of one guess share one shard (30 judged, then held),
      // whichever whitespace they wear, and the raw variants each charge the
      // egress once.
      clock.advance(60_000); // a fresh minute for the per-IP refresh route budget
      const guess = `rt-guess-${crypto.randomUUID()}`;
      const variants = [guess, ` ${guess}`, `${guess} `, `\t${guess}\n`, `  ${guess}  `];
      for (const v of variants) deadRefresh.add(v.trim());
      const statuses: number[] = [];
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit - 1; i += 1) {
        statuses.push((await postRefresh(h.handler, ip, variants[i % variants.length])).status);
      }
      assertEquals(
        count(statuses, 401),
        AUTH_FAILURE_LIMIT.limit - 1,
        `statuses ${statuses.join(",")}`,
      );
      assertEquals(
        await egressCharged(ip),
        AUTH_FAILURE_LIMIT.limit,
        "29 variants + the max token = 30",
      );
      const held = await postRefresh(h.handler, ip, variants[3]);
      assertEquals(held.status, 429, "the shard is one credential across whitespace");
      assertRetryAfterBounded(held);
    });
  },
);

// ── Attack 5: Auth answers with shapes that are NOT verdicts. None of them
// may charge the venue's egress, none may leak a 5xx body, and a well-formed
// refusal right after must still be charged exactly once. ──────────────────
Deno.test(
  "non-verdict Auth answers (429 + Retry-After, 302 redirect, 401 HTML, 403 empty object, 200 garbage) charge nothing and never crash the edge; the first real refusal after them is charged once",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      const ip = freshIp();
      const forgedBearers = new Set<string>();
      const shapes = new Map<string, () => Response>();
      installAuth(h, {
        forgedBearers,
        override: (call) => {
          if (!isUserCall(call)) return null;
          return shapes.get(bearerOfCall(call))?.() ?? null;
        },
      });

      const expectations: Array<[string, () => Response, number[]]> = [
        [
          "rate-limited",
          () =>
            jsonResponse(
              429,
              {
                code: 429,
                error_code: "over_request_rate_limit",
                msg: "Request rate limit reached",
              },
              { "Retry-After": "7" },
            ),
          [503, 429],
        ],
        [
          "redirect",
          () =>
            new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/" } }),
          [503],
        ],
        [
          "html-401",
          () =>
            new Response("<html><body>Unauthorized</body></html>", {
              status: 401,
              headers: { "Content-Type": "text/html" },
            }),
          [503],
        ],
        ["empty-403", () => jsonResponse(403, {}), [401]],
        ["garbage-200", () => new Response("{not json", { status: 200 }), [503]],
        ["null-200", () => jsonResponse(200, null), [503]],
      ];
      let expectedCharge = 0;
      for (const [label, shape, accepted] of expectations) {
        clock.advance(1_000);
        const bearer = supabaseBearer(label);
        shapes.set(bearer, shape);
        const response = await readMe(h.handler, ip, bearer);
        assert(
          accepted.includes(response.status),
          `${label}: status ${response.status} not in ${accepted.join("/")}`,
        );
        assert(
          response.status < 500 || response.status === 503,
          `${label}: leaked ${response.status}`,
        );
        // Only a well-formed refusal (the empty 403 object) is a verdict.
        if (label === "empty-403") expectedCharge += 1;
        assertEquals(await egressCharged(ip), expectedCharge, `${label}: egress charge`);
      }

      clock.advance(1_000);
      const forged = supabaseBearer("real-refusal");
      forgedBearers.add(forged);
      assertEquals((await readMe(h.handler, ip, forged)).status, 401);
      assertEquals(await egressCharged(ip), expectedCharge + 1, "one real refusal, one charge");
      // Replaying a bearer Auth could not judge is still judged (not held).
      const userCallsBefore = h.calls.filter(isUserCall).length;
      const retried = await readMe(h.handler, ip, [...shapes.keys()][0]);
      assertEquals(retried.status === 503 || retried.status === 429, true);
      assertEquals(
        h.calls.filter(isUserCall).length,
        userCallsBefore + 1,
        "a non-verdict never holds",
      );
    });
  },
);

// ── Attack 6: the transitional raw-provider-token bearer path — thirty
// forged Google ID tokens presented as BEARERS (not on bootstrap) saturate
// the egress; the venue's Supabase session bearers, refreshes and logouts
// must keep working, and a forged ID token replay is held before Auth. ─────
Deno.test(
  "provider-token bearers: thirty forged ID tokens as bearers saturate the egress once each, a replay of one is held before Auth, and the venue's minted session bearer, refresh and logout still pass",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      const ip = freshIp();
      const forgedIdTokens = new Set<string>();
      installAuth(h, { forgedIdTokens });
      h.tables.profiles = [profile()];

      const handset = await mintHandset(h.handler, ip);
      clock.advance(1_000);
      const idTokenCallsBefore = h.calls.filter(isIdTokenCall).length;
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        const forged = googleIdToken(`forged-${i}`);
        forgedIdTokens.add(forged);
        assertEquals((await readMe(h.handler, ip, forged)).status, 401);
      }
      assertEquals(
        h.calls.filter(isIdTokenCall).length,
        idTokenCallsBefore + AUTH_FAILURE_LIMIT.limit,
      );
      assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit);

      clock.advance(1_000);
      const replay = await readMe(h.handler, ip, [...forgedIdTokens][0]);
      assertEquals(replay.status, 429);
      assertRetryAfterBounded(replay);
      assertEquals(
        h.calls.filter(isIdTokenCall).length,
        idTokenCallsBefore + AUTH_FAILURE_LIMIT.limit,
      );

      assertEquals((await readMe(h.handler, ip, handset.accessToken)).status, 200);
      const rotated = await sendJson(h.handler, refreshRequest(ip, handset.refreshToken));
      assertEquals(rotated.status, 200);
      const nextBearer = sessionField(rotated.body, "accessToken");
      assert(nextBearer, "rotation minted a bearer");
      assertEquals((await readMe(h.handler, ip, nextBearer)).status, 200);
      const logout = await postLogout(h.handler, ip, nextBearer);
      assert(logout.status === 200 || logout.status === 204, `logout ${logout.status}`);
      assertEquals(await egressCharged(ip), AUTH_FAILURE_LIMIT.limit, "the venue charged nothing");
    });
  },
);
