// W11-01 — auth-failure budgets behind a shared egress (NAT).
//
// Contract pinned here (rateLimit.ts "Auth-failure budgets behind a shared
// egress" + the wiring in index.ts):
//
//   C1  A refusal is classified. `local` never reached Supabase Auth and
//       charges nothing. `liveness` is Auth's verdict on a REAL credential
//       that is no longer live (session_not_found, session_expired,
//       user_not_found, user_banned, refresh_token_already_used) and charges
//       only that credential's own shard. `credential` is a guess and charges
//       its shard plus the egress-wide stuffing signal. `not_found` (GoTrue's
//       refresh_token_not_found — a token it holds no row for) is decided by
//       provenance: a refresh token THIS edge minted is liveness, one nothing
//       here ever minted is a guess.
//   C2  The stuffing signal counts DISTINCT refused guesses per egress. Once
//       it reaches the budget, a credential nothing has vouched for is 429
//       before Auth; a vouched credential (minted here, verified here, or
//       judged dead by Auth) is still judged by Auth — so a peer's session,
//       its refresh, and a signed-out handset's 401 all survive a co-tenant
//       flood, while forged novelty is bounded to the budget upstream.
//   C3  A single credential refused `limit` times in a window is 429 before
//       Auth (replay throttle), whatever the egress signal says.
//   C4  Shard storage is attacker-cardinality; when it cannot admit a shard
//       the refusal is charged to the egress signal instead. Exhaustion
//       therefore fails CLOSED on the egress, never open.
//
// On BASE (ca928231) every 401 charged one flat `authfail:<ip>` window, so
// thirty dead sessions or thirty junk bearers behind one NAT answered 429 to
// every valid peer for the rest of the window (index.ts:4998-5017).
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json rateLimit_nat_budget.test.ts

import { assert, assertEquals, configureRedis, loadIsolate } from "./harness.ts";
import {
  fakeSupabaseAccessToken,
  loadHarness,
  type RecordedCall,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

const BUDGET = { limit: 30, windowSeconds: 300 };

// ── C1–C4 on the primitives ─────────────────────────────────────────────────

async function primitives() {
  configureRedis(false);
  const iso = await loadIsolate();
  const rl = iso.rateLimit;
  const id = (label: string) => rl.authFailureIdentity(label) as Promise<string>;
  const stuffing = async (ip: string) =>
    BUDGET.limit - (await rl.peekAuthStuffing(ip, BUDGET)).remaining;
  return { rl, id, stuffing };
}

function frozenClock(): () => void {
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  return () => {
    Date.now = realNow;
  };
}

Deno.test(
  "C1 authRefusalKind: GoTrue liveness codes are liveness, refresh_token_not_found is not_found (provenance decides), anything else is a guess",
  async () => {
    const { rl } = await primitives();
    for (const code of [
      "session_not_found",
      "session_expired",
      "user_not_found",
      "user_banned",
      "refresh_token_already_used",
    ]) {
      assertEquals(rl.authRefusalKind({ code: 401, error_code: code, msg: "x" }), "liveness", code);
      assertEquals(
        rl.authErrorRefusalKind({ name: "AuthApiError", code, status: 401 }),
        "liveness",
      );
    }
    assertEquals(
      rl.authRefusalKind({
        error: "invalid_grant",
        error_description: "Invalid Refresh Token: Refresh Token Not Found",
        error_code: "refresh_token_not_found",
      }),
      "not_found",
    );
    for (const code of ["bad_jwt", "bad_id_token", "invalid_credentials", "made_up_code"]) {
      assertEquals(
        rl.authRefusalKind({ code: 401, error_code: code, msg: "x" }),
        "credential",
        code,
      );
    }
    // Older GoTrue bodies carry only a message.
    assertEquals(
      rl.authRefusalKind({ code: 401, msg: "Session from session_id claim in JWT does not exist" }),
      "liveness",
    );
    assertEquals(
      rl.authRefusalKind({
        error: "invalid_grant",
        error_description: "Invalid Refresh Token: Already Used",
      }),
      "liveness",
    );
    assertEquals(
      rl.authRefusalKind({ code: 401, msg: "invalid JWT: unable to parse or verify signature" }),
      "credential",
    );
    assertEquals(rl.authRefusalKind("not json"), "credential");
    assertEquals(rl.authRefusalKind(null), "credential");
    assertEquals(rl.authErrorRefusalKind(undefined), "credential");
  },
);

Deno.test(
  "C1 dead sessions charge their own shard only: forty distinct liveness refusals leave the egress stuffing signal at zero",
  async () => {
    const restore = frozenClock();
    try {
      const { rl, id, stuffing } = await primitives();
      const ip = "100.64.1.1";
      for (let i = 0; i < 40; i += 1) {
        await rl.chargeAuthFailure(ip, await id(`dead-${i}`), { kind: "liveness" }, BUDGET);
      }
      assertEquals(await stuffing(ip), 0, "liveness never moves the egress signal");
      assertEquals((await rl.peekAuthFailureBudget(ip, await id("novel"), BUDGET)).allowed, true);
      assertEquals((await rl.peekAuthFailureBudget(ip, await id("dead-7"), BUDGET)).allowed, true);
      // Auth judged those credentials real: they are vouched for the window.
      for (let i = 0; i < 40; i += 1) {
        await rl.chargeAuthFailure(ip, await id(`guess-${i}`), { kind: "credential" }, BUDGET);
      }
      assertEquals(await stuffing(ip), BUDGET.limit, "the signal saturates at the budget");
      assertEquals((await rl.peekAuthFailureBudget(ip, await id("dead-7"), BUDGET)).allowed, true);
      assertEquals((await rl.peekAuthFailureBudget(ip, await id("novel"), BUDGET)).allowed, false);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "C2 thirty distinct guesses saturate the egress: a novel credential is 429 before Auth, a vouched peer is not, and another egress is untouched",
  async () => {
    const restore = frozenClock();
    try {
      const { rl, id, stuffing } = await primitives();
      const ip = "100.64.2.1";
      await rl.vouchAuthCredential("peer-access", 3600);
      await rl.vouchAuthSession({
        access_token: "peer-a2",
        refresh_token: "peer-r2",
        expires_in: 3600,
      });
      for (let i = 0; i < BUDGET.limit - 1; i += 1) {
        await rl.chargeAuthFailure(ip, await id(`guess-${i}`), { kind: "credential" }, BUDGET);
        assertEquals((await rl.peekAuthFailureBudget(ip, await id("novel"), BUDGET)).allowed, true);
      }
      // A replay of an already-refused guess is a shard hit, not a new signal.
      await rl.chargeAuthFailure(ip, await id("guess-0"), { kind: "credential" }, BUDGET);
      assertEquals(await stuffing(ip), BUDGET.limit - 1, "one hit per distinct guess");
      await rl.chargeAuthFailure(ip, await id("guess-last"), { kind: "credential" }, BUDGET);
      assertEquals(await stuffing(ip), BUDGET.limit);

      const novel = await rl.peekAuthFailureBudget(ip, await id("novel"), BUDGET);
      assertEquals(novel.allowed, false);
      assertEquals(novel.remaining, 0);
      assert(novel.retryAfterSeconds >= 1 && novel.retryAfterSeconds <= BUDGET.windowSeconds);
      const res = rl.rateLimitResponse(novel);
      assertEquals(res.status, 429);
      assertEquals(res.headers.get("Retry-After"), String(novel.retryAfterSeconds));
      await res.body?.cancel();

      for (const vouched of ["peer-access", "peer-a2", "peer-r2"]) {
        assertEquals(
          (await rl.peekAuthFailureBudget(ip, await id(vouched), BUDGET)).allowed,
          true,
          vouched,
        );
      }
      assertEquals(
        (await rl.peekAuthFailureBudget(ip, null, BUDGET)).allowed,
        true,
        "no credential → local refusal, not a 429",
      );
      assertEquals(
        (await rl.peekAuthFailureBudget("100.64.2.2", await id("novel"), BUDGET)).allowed,
        true,
      );
      assertEquals(await stuffing("100.64.2.2"), 0);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "C1 refresh_token_not_found is charged by provenance: a refresh token this edge minted is liveness, one nothing minted is a guess",
  async () => {
    const restore = frozenClock();
    try {
      const { rl, id, stuffing } = await primitives();
      const ip = "100.64.3.1";
      await rl.vouchAuthSession({
        access_token: "a1",
        refresh_token: "rt-minted-here",
        expires_in: 3600,
      });
      for (let i = 0; i < 5; i += 1) {
        await rl.chargeAuthFailure(ip, await id("rt-minted-here"), { kind: "not_found" }, BUDGET);
      }
      assertEquals(await stuffing(ip), 0, "a signed-out handset retrying is not an attack");
      await rl.chargeAuthFailure(ip, await id("rt-never-minted"), { kind: "not_found" }, BUDGET);
      assertEquals(await stuffing(ip), 1, "a refresh token nobody minted is a guess");
      // The refusal may name the credential it judged (a refresh judges the
      // body, not the bearer): the named identity is the one charged.
      await rl.chargeAuthFailure(
        ip,
        null,
        { kind: "not_found", identity: await id("rt-other-forged") },
        BUDGET,
      );
      assertEquals(await stuffing(ip), 2);
      await rl.chargeAuthFailure(
        ip,
        await id("bearer"),
        { kind: "credential", identity: null },
        BUDGET,
      );
      assertEquals(await stuffing(ip), 2, "a refusal naming no identity charges nothing");
      await rl.chargeAuthFailure(ip, await id("bearer"), { kind: "local" }, BUDGET);
      assertEquals(await stuffing(ip), 2, "local refusals charge nothing");
    } finally {
      restore();
    }
  },
);

Deno.test(
  "C3 one credential refused thirty times is 429 before Auth while the egress stays quiet; the window rollover releases it",
  async () => {
    const realNow = Date.now;
    let now =
      Math.floor(realNow() / (BUDGET.windowSeconds * 1_000)) * BUDGET.windowSeconds * 1_000 + 1_000;
    Date.now = () => now;
    try {
      const { rl, id, stuffing } = await primitives();
      const ip = "100.64.4.1";
      const replayed = await id("one-bad-bearer");
      for (let i = 0; i < BUDGET.limit; i += 1) {
        assertEquals(
          (await rl.peekAuthFailureBudget(ip, replayed, BUDGET)).allowed,
          true,
          `presentation ${i + 1}`,
        );
        await rl.chargeAuthFailure(ip, replayed, { kind: "credential" }, BUDGET);
      }
      const throttled = await rl.peekAuthFailureBudget(ip, replayed, BUDGET);
      assertEquals(throttled.allowed, false);
      assertEquals(throttled.remaining, 0);
      assertEquals(await stuffing(ip), 1, "thirty replays are ONE distinct guess");
      assertEquals((await rl.peekAuthFailureBudget(ip, await id("novel"), BUDGET)).allowed, true);
      now += BUDGET.windowSeconds * 1_000;
      assertEquals(
        (await rl.peekAuthFailureBudget(ip, replayed, BUDGET)).allowed,
        true,
        "next window",
      );
      assertEquals(await stuffing(ip), 0);
    } finally {
      Date.now = realNow;
    }
  },
);

Deno.test(
  "C4 shard-store exhaustion never fails open: with no shard admitted every refusal charges the egress and the next novel credential is 429",
  async () => {
    const restore = frozenClock();
    try {
      const { rl, id, stuffing } = await primitives();
      const flood = "100.64.5.1";
      for (let i = 0; i < 20_000; i += 1) {
        await rl.chargeAuthFailure(flood, `shard-${i}`, { kind: "credential" }, BUDGET);
      }
      assertEquals(await stuffing(flood), BUDGET.limit);

      const ip = "100.64.5.2";
      await rl.vouchAuthCredential("peer", 3600);
      const replayed = await id("one-bad-bearer");
      for (let i = 0; i < BUDGET.limit; i += 1) {
        await rl.chargeAuthFailure(ip, replayed, { kind: "credential" }, BUDGET);
      }
      assertEquals(
        await stuffing(ip),
        BUDGET.limit,
        "unshardable refusals fall through to the egress signal",
      );
      assertEquals((await rl.peekAuthFailureBudget(ip, replayed, BUDGET)).allowed, false);
      assertEquals((await rl.peekAuthFailureBudget(ip, await id("novel"), BUDGET)).allowed, false);
      assertEquals(
        (await rl.peekAuthFailureBudget(ip, await id("peer"), BUDGET)).allowed,
        true,
        "the vouched peer still reaches Auth",
      );
      assertEquals(
        (await rl.peekAuthFailureBudget("100.64.5.3", await id("novel"), BUDGET)).allowed,
        true,
        "another egress is untouched",
      );
    } finally {
      restore();
    }
  },
);

// ── On the wire (the real handler, scripted Supabase Auth) ──────────────────

type Json = Record<string, unknown>;

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const profile = () => ({
  id: TEST_USER_ID,
  email: "user@example.com",
  provider: "google",
  onboarding_state: "complete",
});

/** A GoTrue that knows which access tokens it minted (live or dead), which
 * refresh tokens it holds, and refuses everything else as a guess. */
class ScriptedAuth {
  readonly live = new Set<string>();
  readonly dead = new Set<string>();
  readonly refreshable = new Map<string, string>();
  tokenGrants = 0;
  userChecks = 0;

  mint(sub = TEST_USER_ID): Json {
    const accessToken = fakeSupabaseAccessToken(sub);
    const refreshToken = `rt-${crypto.randomUUID()}`;
    this.live.add(accessToken);
    this.refreshable.set(refreshToken, sub);
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: refreshToken,
      user: this.user(sub),
    };
  }

  user(sub: string): Json {
    return {
      id: sub,
      aud: "authenticated",
      role: "authenticated",
      email: "user@example.com",
      app_metadata: { provider: "google", providers: ["google"] },
      user_metadata: {},
      created_at: "2026-01-01T00:00:00.000Z",
    };
  }

  /** Sign the session out elsewhere: its access token is dead, its refresh
   * token row is gone (GoTrue cascades refresh_tokens on session delete). */
  signOut(accessToken: string, refreshToken: string) {
    this.live.delete(accessToken);
    this.dead.add(accessToken);
    this.refreshable.delete(refreshToken);
  }

  respond = (call: RecordedCall): Response | null => {
    const url = new URL(call.url);
    if (!url.pathname.startsWith("/auth/v1/")) return null;
    const body = (call.body ?? {}) as Json;
    if (url.pathname === "/auth/v1/token") {
      this.tokenGrants += 1;
      const grant = url.searchParams.get("grant_type");
      if (grant === "id_token") {
        const token = typeof body.id_token === "string" ? body.id_token : "";
        const sub = jwtSub(token);
        if (sub !== TEST_USER_ID) {
          return jsonResponse(400, {
            error: "invalid_grant",
            error_description: "Bad ID token",
            error_code: "bad_id_token",
          });
        }
        return jsonResponse(200, this.mint(sub));
      }
      if (grant === "refresh_token") {
        const presented = typeof body.refresh_token === "string" ? body.refresh_token : "";
        const sub = this.refreshable.get(presented);
        if (sub === undefined) {
          return jsonResponse(400, {
            error: "invalid_grant",
            error_description: "Invalid Refresh Token: Refresh Token Not Found",
            error_code: "refresh_token_not_found",
          });
        }
        this.refreshable.delete(presented);
        return jsonResponse(200, this.mint(sub));
      }
      return jsonResponse(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/auth/v1/user" && call.method === "GET") {
      this.userChecks += 1;
      const bearer = (call.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (this.live.has(bearer)) return jsonResponse(200, this.user(jwtSub(bearer)));
      if (this.dead.has(bearer)) {
        return jsonResponse(401, {
          code: 401,
          error_code: "session_not_found",
          msg: "Session from session_id claim in JWT does not exist",
        });
      }
      return jsonResponse(401, {
        code: 401,
        error_code: "bad_jwt",
        msg: "invalid JWT: unable to parse or verify signature",
      });
    }
    return null;
  };
}

function jwtSub(token: string): string {
  try {
    const segment = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const sub = JSON.parse(atob(segment)).sub;
    return typeof sub === "string" ? sub : "";
  } catch {
    return "";
  }
}

const forgedBearer = () => fakeSupabaseAccessToken(crypto.randomUUID());
const PROBE = "/v1/me/consent/status";

const b64url = (text: string) =>
  btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A distinct Google ID token per handset (real ones carry a fresh iat/jti;
 * the harness's default is deterministic under a frozen clock). */
function handsetIdToken(sub = TEST_USER_ID): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub,
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: crypto.randomUUID(),
    }),
  );
  return `${header}.${payload}.sig`;
}

async function wire() {
  const h = await loadHarness();
  h.reset();
  const auth = new ScriptedAuth();
  h.respond = auth.respond;
  h.tables.profiles = [profile()];
  const call = async (request: Request) => {
    const response = await h.handler(request);
    const status = response.status;
    const retryAfter = response.headers.get("Retry-After");
    const body = (await response.json().catch(() => null)) as Json | null;
    return { status, retryAfter, body };
  };
  const bootstrap = async (ip: string) => {
    const res = await call(
      userRequest("POST", "/v1/account/bootstrap", { token: handsetIdToken(), ip, body: {} }),
    );
    assertEquals(res.status, 200, `bootstrap → ${res.status} ${JSON.stringify(res.body)}`);
    const session = (res.body as { session: { accessToken: string; refreshToken: string } })
      .session;
    return session;
  };
  return { h, auth, call, bootstrap };
}

Deno.test(
  "venue behind one NAT: thirty forged bearers from a co-tenant leave the peer's session and refresh online; the next forged bearer is 429 before Auth and a neighbouring address is untouched",
  async () => {
    const restore = frozenClock();
    try {
      const { auth, call, bootstrap } = await wire();
      const ip = "100.64.11.1";
      const peer = await bootstrap(ip);
      assertEquals(
        (await call(userRequest("GET", PROBE, { token: peer.accessToken, ip }))).status,
        200,
      );

      const before = auth.userChecks;
      for (let i = 0; i < BUDGET.limit; i += 1) {
        const guess = await call(userRequest("GET", PROBE, { token: forgedBearer(), ip }));
        assertEquals(guess.status, 401, `forged bearer ${i + 1} is judged by Auth`);
      }
      assertEquals(auth.userChecks - before, BUDGET.limit);
      const deferred = await call(userRequest("GET", PROBE, { token: forgedBearer(), ip }));
      assertEquals(deferred.status, 429, "the 31st distinct forged bearer is 429 before Auth");
      assert(
        Number(deferred.retryAfter) >= 1 && Number(deferred.retryAfter) <= BUDGET.windowSeconds,
      );
      assertEquals(auth.userChecks - before, BUDGET.limit, "it never reached Auth");

      // The peer's cached session is served, its refresh rotates, and the
      // rotated (uncached, but minted here) bearer is verified by Auth.
      assertEquals(
        (await call(userRequest("GET", PROBE, { token: peer.accessToken, ip }))).status,
        200,
      );
      const rotated = await call(
        userRequest("POST", "/v1/auth/refresh", {
          token: peer.accessToken,
          ip,
          body: { refreshToken: peer.refreshToken },
        }),
      );
      assertEquals(rotated.status, 200, `peer refresh → ${rotated.status}`);
      const next = (rotated.body as { session: { accessToken: string } }).session.accessToken;
      const checks = auth.userChecks;
      assertEquals((await call(userRequest("GET", PROBE, { token: next, ip }))).status, 200);
      assertEquals(auth.userChecks, checks + 1, "the rotated bearer was verified upstream");

      // Forged novelty stays bounded: a sign-in nothing vouches for from the
      // stuffed address waits for the window (retryable), never a lockout of
      // established peers.
      const grants = auth.tokenGrants;
      const signIn = await call(
        userRequest("POST", "/v1/account/bootstrap", { token: handsetIdToken(), ip, body: {} }),
      );
      assertEquals(signIn.status, 429);
      assertEquals(auth.tokenGrants, grants, "no upstream grant was spent for it");

      const neighbour = await call(
        userRequest("GET", PROBE, { token: forgedBearer(), ip: "100.64.11.2" }),
      );
      assertEquals(neighbour.status, 401, "another egress is judged by Auth as usual");
    } finally {
      restore();
    }
  },
);

Deno.test(
  "a signed-out handset keeps receiving 401 — never 429 — before and after a co-tenant stuffs the egress, for its access token and its refresh token alike",
  async () => {
    const restore = frozenClock();
    try {
      const { auth, call, bootstrap } = await wire();
      const ip = "100.64.12.1";
      const handset = await bootstrap(ip);
      auth.signOut(handset.accessToken, handset.refreshToken);

      // Thirty liveness refusals from the handset: not one moves the egress
      // signal, so a co-tenant's first guess is still judged by Auth.
      for (let i = 0; i < 25; i += 1) {
        const dead = await call(userRequest("GET", PROBE, { token: handset.accessToken, ip }));
        assertEquals(dead.status, 401, `dead session ${i + 1} → 401`);
      }
      for (let i = 0; i < 5; i += 1) {
        const dead = await call(
          userRequest("POST", "/v1/auth/refresh", {
            token: handset.accessToken,
            ip,
            body: { refreshToken: handset.refreshToken },
          }),
        );
        assertEquals(dead.status, 401, `dead refresh ${i + 1} → 401 (the app's sign-out signal)`);
      }
      const checks = auth.userChecks;
      assertEquals(
        (await call(userRequest("GET", PROBE, { token: forgedBearer(), ip }))).status,
        401,
      );
      assertEquals(auth.userChecks, checks + 1, "the egress was not under stuffing");

      for (let i = 0; i < BUDGET.limit; i += 1) {
        assertEquals(
          (await call(userRequest("GET", PROBE, { token: forgedBearer(), ip }))).status,
          401,
        );
      }
      assertEquals(
        (await call(userRequest("GET", PROBE, { token: forgedBearer(), ip }))).status,
        429,
      );

      for (let i = 0; i < 3; i += 1) {
        const dead = await call(userRequest("GET", PROBE, { token: handset.accessToken, ip }));
        assertEquals(dead.status, 401, `dead session under stuffing ${i + 1} → 401, not 429`);
        assertEquals(dead.retryAfter, null);
      }
      const deadRefresh = await call(
        userRequest("POST", "/v1/auth/refresh", {
          token: handset.accessToken,
          ip,
          body: { refreshToken: handset.refreshToken },
        }),
      );
      assertEquals(
        deadRefresh.status,
        401,
        "the refused refresh token still tells the app to sign in again",
      );
    } finally {
      restore();
    }
  },
);

Deno.test(
  "forged novelty from one egress is bounded before Auth: of a hundred forged bearers exactly the budget reaches GoTrue",
  async () => {
    const restore = frozenClock();
    try {
      const { auth, call } = await wire();
      const ip = "100.64.13.1";
      const statuses = new Map<number, number>();
      for (let i = 0; i < 100; i += 1) {
        const res = await call(userRequest("GET", PROBE, { token: forgedBearer(), ip }));
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      }
      assertEquals(statuses.get(401), BUDGET.limit);
      assertEquals(statuses.get(429), 100 - BUDGET.limit);
      assertEquals(auth.userChecks, BUDGET.limit);
    } finally {
      restore();
    }
  },
);
