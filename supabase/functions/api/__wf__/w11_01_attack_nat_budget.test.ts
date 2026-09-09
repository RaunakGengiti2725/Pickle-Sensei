// W11-01 ADVERSARY — attacks on candidate 1289df2b (auth-failure budgets behind
// a NAT egress: per-credential shards, liveness vs credential refusals, minted
// session admission). Every test states the behaviour the package promises;
// a FAILING test is a reproduced break, a passing one is an attack that held.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json w11_01_attack_nat_budget.test.ts

import { assert, assertEquals } from "@std/assert";
import { peekRateLimit } from "../rateLimit.ts";
import { configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";
import {
  fakeSupabaseAccessToken,
  type Harness,
  loadHarness,
  OTHER_USER_ID,
  type RecordedCall,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

/** Mirrors AUTH_FAILURE_LIMIT in index.ts. */
const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };

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

const jwtSubjectOf = (token: string): string | null => {
  const segment = (token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
  try {
    const payload: unknown = JSON.parse(atob(segment + "=".repeat((4 - (segment.length % 4)) % 4)));
    if (typeof payload !== "object" || payload === null) return null;
    const sub = (payload as Record<string, unknown>).sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
};

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
const bodyField = (call: RecordedCall, field: string): string => {
  const body = call.body;
  if (typeof body !== "object" || body === null) return "";
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
};

let ipCounter = 0;
const freshIp = () => `10.91.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const spent = (window: { limit: number; remaining: number }) => window.limit - window.remaining;
const egressCharged = async (ip: string): Promise<number> =>
  spent(
    await peekRateLimit("authfail", ip, AUTH_FAILURE_LIMIT.limit, AUTH_FAILURE_LIMIT.windowSeconds),
  );

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
  const token = (session as Record<string, unknown>)[field];
  return typeof token === "string" ? token : "";
};

/** Sign a handset in through the edge; both tokens the edge minted. */
async function mintHandset(
  handler: Handler,
  ip: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const minted = await sendJson(handler, refreshRequest(ip, `rt-live-${crypto.randomUUID()}`));
  assertEquals(minted.status, 200, "handset signed in");
  const accessToken = sessionField(minted.body, "accessToken");
  const refreshToken = sessionField(minted.body, "refreshToken");
  assert(accessToken && refreshToken, "the edge handed the handset a session");
  return { accessToken, refreshToken };
}

const repeat = async (times: number, run: (i: number) => Promise<Response>): Promise<number[]> => {
  const statuses: number[] = [];
  for (let i = 0; i < times; i += 1) statuses.push((await run(i)).status);
  return statuses;
};

const count = (statuses: number[], status: number) => statuses.filter((s) => s === status).length;

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

function installAuth(
  h: { respond: (call: RecordedCall) => Response | null | Promise<Response | null> },
  sets: { forgedBearers?: Set<string>; deadRefresh?: Set<string> },
) {
  h.respond = (call) => {
    if (isUserCall(call)) {
      if (sets.forgedBearers?.has(bearerOfCall(call))) return credentialRefused();
      return null;
    }
    if (isRefreshCall(call)) {
      if (sets.deadRefresh?.has(bodyField(call, "refresh_token"))) return refreshRefused();
      return mintedSession(TEST_USER_ID);
    }
    if (isIdTokenCall(call)) {
      const idToken = bodyField(call, "id_token");
      if (sets.forgedBearers?.has(idToken)) return idTokenRefused();
      return mintedSession(jwtSubjectOf(idToken) ?? TEST_USER_ID);
    }
    return null;
  };
}

/**
 * Saturate `ip`'s stuffing signal with thirty distinct forged bearers.
 * Saturation is observed through the handler itself (a 31st never-seen
 * bearer is held before Auth) so it also holds for a restarted isolate,
 * whose rateLimit module instance is not the one this file imported.
 */
async function floodEgress(h: Harness, handler: Handler, ip: string, forgedBearers: Set<string>) {
  const statuses = await repeat(AUTH_FAILURE_LIMIT.limit, (i) => {
    const bearer = supabaseBearer(`co-tenant-${i}-${crypto.randomUUID()}`);
    forgedBearers.add(bearer);
    return readMe(handler, ip, bearer);
  });
  assertEquals(count(statuses, 401), AUTH_FAILURE_LIMIT.limit, `flood ${statuses.join(",")}`);
  const judged = h.calls.filter(isUserCall).length;
  const probe = supabaseBearer(`co-tenant-probe-${crypto.randomUUID()}`);
  forgedBearers.add(probe);
  assertEquals((await readMe(handler, ip, probe)).status, 429, "egress saturated");
  assertEquals(h.calls.filter(isUserCall).length, judged, "the 31st guess never reached Auth");
}

let isolateSeq = 0;

/**
 * A SECOND edge isolate of the same deployment (or the same isolate after a
 * restart): index.ts re-materialised with its own rateLimit.ts + cache.ts
 * module instances, exactly as harness.ts `loadIsolate` does for the
 * primitives. The routesHarness `Deno.serve` stub captures the new handler.
 * Restores `h.handler` when `run` finishes.
 */
async function withRestartedIsolate(h: Harness, run: (handler: Handler) => Promise<void>) {
  const before = h.handler;
  const apiDir = new URL("../", import.meta.url);
  isolateSeq += 1;
  const tag = `${Date.now()}-${isolateSeq}`;
  const cacheSpecifier = new URL(`cache.ts?attack-iso=${tag}`, apiDir).href;
  const rateLimitSource = await Deno.readTextFile(new URL("rateLimit.ts", apiDir));
  const rateLimitBlob = URL.createObjectURL(
    new Blob([rateLimitSource.replace('from "./cache.ts"', `from "${cacheSpecifier}"`)], {
      type: "application/typescript",
    }),
  );
  const indexSource = await Deno.readTextFile(new URL("index.ts", apiDir));
  const patchedIndex = indexSource
    .replace('from "./cache.ts"', `from "${cacheSpecifier}"`)
    .replace('from "./rateLimit.ts"', `from "${rateLimitBlob}"`)
    .replace(/from "\.\/([A-Za-z0-9_]+\.ts)"/g, (_m, file: string) => {
      return `from "${new URL(file, apiDir).href}"`;
    });
  const indexBlob = URL.createObjectURL(
    new Blob([patchedIndex], { type: "application/typescript" }),
  );
  try {
    await import(indexBlob);
    assert(h.handler !== before, "the restarted isolate registered its own handler");
    await run(h.handler);
  } finally {
    URL.revokeObjectURL(indexBlob);
    URL.revokeObjectURL(rateLimitBlob);
    h.handler = before;
  }
}

// ─── ATTACK 1: concurrency — a parallel burst of DISTINCT forged credentials ──

Deno.test(
  "ATTACK 1 (concurrency, distinct credentials): 120 parallel forged bearers from one egress reach Supabase Auth at most thirty times",
  async () => {
    await withPinnedClock(async () => {
      const h = await loadHarness();
      const ip = freshIp();
      const forgedBearers = new Set<string>();
      installAuth(h, { forgedBearers });
      const burst = Array.from({ length: 120 }, (_, i) => {
        const bearer = supabaseBearer(`burst-${i}`);
        forgedBearers.add(bearer);
        return bearer;
      });

      const statuses = (
        await Promise.all(burst.map((bearer) => readMe(h.handler, ip, bearer)))
      ).map((response) => response.status);
      const judged = h.calls.filter(isUserCall).length;

      // The package's own contract: "at most 30 guesses per egress per window
      // reach Auth, whatever mix of routes carries them, even in one parallel
      // burst" (rateLimit_nat_budget.test.ts header; implementer summary).
      assert(
        judged <= AUTH_FAILURE_LIMIT.limit,
        `${judged} distinct forged bearers reached Auth in one burst (statuses: 401×${count(statuses, 401)} 429×${count(statuses, 429)})`,
      );
    });
  },
);

// ─── ATTACK 2: concurrency — a VALID bearer's own parallel fan-out ───────────

Deno.test(
  "ATTACK 2 (concurrency, valid credential): forty parallel requests bearing one valid, not-yet-cached session token are all 200 — an auth-FAILURE budget must not throttle a credential Auth accepts",
  async () => {
    await withPinnedClock(async () => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      installAuth(h, {});
      // A session bearer no earlier request has cached (fresh session_id).
      const valid = supabaseBearer(`valid-fanout-${crypto.randomUUID()}`);

      const statuses = (
        await Promise.all(Array.from({ length: 40 }, () => readMe(h.handler, ip, valid)))
      ).map((response) => response.status);

      assertEquals(await egressCharged(ip), 0, "nothing was refused");
      assertEquals(
        count(statuses, 200),
        40,
        `a valid bearer was throttled by its own fan-out: 200×${count(statuses, 200)} 429×${count(statuses, 429)}`,
      );
    });
  },
);

// ─── ATTACK 3: boundary — a venue handset idle past the minted-registry TTL ──

Deno.test(
  "ATTACK 3 (clock boundary): a handset the edge signed in 25 h ago still rotates its (Auth-valid) refresh token and verifies its bearer while a co-tenant floods the venue's egress",
  async () => {
    await withPinnedClock(async (clock) => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const forgedBearers = new Set<string>();
      installAuth(h, { forgedBearers });

      // Friday evening: the handset signs in through the edge.
      const handset = await mintHandset(h.handler, ip);

      // Sunday: 25 h later the handset wakes up behind the same NAT while a
      // co-tenant is guessing bearers.
      clock.advance(25 * 3_600_000);
      await floodEgress(h, h.handler, ip, forgedBearers);
      const refreshCallsBefore = h.calls.filter(isRefreshCall).length;

      const rotated = await postRefresh(h.handler, ip, handset.refreshToken);
      assertEquals(
        rotated.status,
        200,
        `the venue's own handset was held (${rotated.status}); Auth would have rotated it (refresh calls: ${h.calls.filter(isRefreshCall).length - refreshCallsBefore})`,
      );
    });
  },
);

// ─── ATTACK 4: process death / restart — minted registry is per-isolate ──────

Deno.test(
  "ATTACK 4a (isolate restart): tokens minted before the restart (or on another isolate) are still admitted to Auth under a co-tenant's flood — the handset's bearer verifies and its refresh rotates",
  async () => {
    await withPinnedClock(async () => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const forgedBearers = new Set<string>();
      installAuth(h, { forgedBearers });

      const handset = await mintHandset(h.handler, ip);

      await withRestartedIsolate(h, async (restarted) => {
        await floodEgress(h, restarted, ip, forgedBearers);
        const userCallsBefore = h.calls.filter(isUserCall).length;
        const refreshCallsBefore = h.calls.filter(isRefreshCall).length;

        const bearer = (await readMe(restarted, ip, handset.accessToken)).status;
        const refresh = (await postRefresh(restarted, ip, handset.refreshToken)).status;
        assertEquals(
          { bearer, refresh },
          { bearer: 200, refresh: 200 },
          `venue handset after restart: Auth asked ${h.calls.filter(isUserCall).length - userCallsBefore}× for the bearer, ${h.calls.filter(isRefreshCall).length - refreshCallsBefore}× for the refresh`,
        );
      });
    });
  },
);

Deno.test(
  "ATTACK 4b (isolate restart): thirty signed-out handsets whose sessions were minted before the restart refresh behind one NAT — the stuffing signal stays 0 and a peer's brand-new sign-in is not held",
  async () => {
    await withPinnedClock(async () => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      const deadRefresh = new Set<string>();
      installAuth(h, { deadRefresh });

      const handsets: string[] = [];
      for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
        handsets.push((await mintHandset(h.handler, ip)).refreshToken);
      }

      await withRestartedIsolate(h, async (restarted) => {
        for (const token of handsets) deadRefresh.add(token);
        const signedOut = await repeat(AUTH_FAILURE_LIMIT.limit, (i) =>
          postRefresh(restarted, ip, handsets[i]),
        );
        assertEquals(count(signedOut, 401), AUTH_FAILURE_LIMIT.limit, signedOut.join(","));

        const idTokenCallsBefore = h.calls.filter(isIdTokenCall).length;
        const newSignIn = (await postBootstrap(restarted, ip, googleIdToken(OTHER_USER_ID))).status;
        const judgedByAuth = h.calls.filter(isIdTokenCall).length - idTokenCallsBefore;
        assertEquals(
          { newSignIn, judgedByAuth },
          { newSignIn: 200, judgedByAuth: 1 },
          "dead sessions minted by this deployment are not a stuffing signal",
        );
      });
    });
  },
);

// ─── ATTACK 5: clock rollback — the sketch forgets, the window store does not ─

Deno.test(
  "ATTACK 5 (clock rollback): a backward clock step across a bucket boundary must not erase a credential's shard or its liveness mark while the egress window survives it",
  async () => {
    await withPinnedClock(async (clock) => {
      const { rateLimit } = await loadIsolate();
      const budget = AUTH_FAILURE_LIMIT;
      const ip = "203.0.113.150";
      const dead = await rateLimit.authFailureIdentity("dead-session-rollback");
      for (let i = 0; i < budget.limit; i += 1) {
        await rateLimit.chargeAuthFailure("bearer", ip, dead, "liveness", budget);
      }
      assertEquals((await rateLimit.peekAuthFailureBudget(ip, dead, budget)).allowed, false);

      // NTP steps the isolate clock back into the previous window for one
      // request, then forward again.
      clock.advance(-2_000);
      await rateLimit.peekAuthFailureBudget(ip, dead, budget);
      clock.advance(2_000);

      const after = await rateLimit.peekAuthFailureBudget(ip, dead, budget);
      assertEquals(
        after.allowed,
        false,
        `the shard forgot ${budget.limit} refusals after a 2 s clock rollback (remaining ${after.remaining})`,
      );
    });
  },
);

// ─── ATTACK 6: duplicate identities — a credential shaped like a digest ──────

Deno.test(
  "ATTACK 6 (duplicate identities): one credential has one identity — noting it as minted under its raw text and gating it under authFailureIdentity() must agree, whatever the credential looks like",
  async () => {
    await withPinnedClock(async () => {
      const { rateLimit } = await loadIsolate();
      const budget = AUTH_FAILURE_LIMIT;
      const ip = "203.0.113.151";
      for (let i = 0; i < budget.limit; i += 1) {
        await rateLimit.chargeAuthFailure(
          "bearer",
          ip,
          await rateLimit.authFailureIdentity(`forged-${i}`),
          "credential",
          budget,
        );
      }
      // A refresh token whose text happens to be 64 lowercase hex characters.
      const hexToken = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      await rateLimit.noteMintedCredential(hexToken, 86_400);
      const identity = await rateLimit.authFailureIdentity(hexToken);
      const viaIdentity = (await rateLimit.peekAuthFailureBudget(ip, identity, budget)).allowed;
      const viaRawText = (await rateLimit.peekAuthFailureBudget(ip, hexToken, budget)).allowed;
      assertEquals(
        { viaIdentity, viaRawText },
        { viaIdentity: true, viaRawText: true },
        "the route gates by authFailureIdentity(token); the mint note used the raw token",
      );
    });
  },
);

// ─── ATTACK 7: Redis-backed deployment — minted registry across isolates ─────

Deno.test(
  "ATTACK 7 (cross-isolate with Redis): a session minted on isolate A is admitted under stuffing on isolate B, and its dead refresh token is liveness there",
  async () => {
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      await withPinnedClock(async () => {
        const a = (await loadIsolate()).rateLimit;
        const b = (await loadIsolate()).rateLimit;
        const budget = AUTH_FAILURE_LIMIT;
        const ip = "203.0.113.152";
        const refreshToken = `rt-${crypto.randomUUID()}`;
        await a.noteMintedSession({
          accessToken: `minted.${crypto.randomUUID()}.sig`,
          refreshToken,
          expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
        });
        for (let i = 0; i < budget.limit; i += 1) {
          await b.chargeAuthFailure(
            "bearer",
            ip,
            await b.authFailureIdentity(`forged-${i}`),
            "credential",
            budget,
          );
        }
        const identity = await b.authFailureIdentity(refreshToken);
        assert((await b.peekAuthFailureBudget(ip, identity, budget)).allowed, "minted elsewhere");
        const venue = "203.0.113.153";
        await b.chargeAuthFailure("refresh", venue, identity, "liveness", budget);
        assertEquals(
          spent(await b.peekRateLimit("authfail", venue, budget.limit, budget.windowSeconds)),
          0,
          "a dead refresh token minted on another isolate is a sign-out, not a guess",
        );
      });
    } finally {
      redis.restore();
      configureRedis(false);
    }
  },
);

// ─── ATTACK 8: replay of one forged credential across every route class ──────

Deno.test(
  "ATTACK 8 (cross-route replay): one forged token presented as bearer, as ID token and as refresh token shares one shard — the 31st presentation is held on whichever route carries it",
  async () => {
    await withPinnedClock(async () => {
      const h = await loadHarness();
      const ip = freshIp();
      const forged = googleIdToken(crypto.randomUUID());
      const forgedBearers = new Set<string>([forged]);
      const deadRefresh = new Set<string>([forged]);
      installAuth(h, { forgedBearers, deadRefresh });

      const statuses: number[] = [];
      for (let i = 0; i < 15; i += 1) {
        statuses.push((await readMe(h.handler, ip, forged)).status);
        statuses.push((await postBootstrap(h.handler, ip, forged)).status);
      }
      assertEquals(count(statuses, 401), 30, statuses.join(","));
      const judged = h.calls.filter(isTokenCall).length;
      assertEquals(judged, 30);

      const held = await postRefresh(h.handler, ip, forged);
      assertEquals(held.status, 429, "the shard follows the credential across classes");
      assertEquals(h.calls.filter(isTokenCall).length, judged, "not judged again");
    });
  },
);

// ─── ATTACK 9: network failure — Auth 5xx during a flood charges nothing ─────

Deno.test(
  "ATTACK 9 (network failure): thirty novel bearers answered 5xx by Auth charge neither shard nor egress and leave no in-flight reservation behind; the same bearers verify once Auth is back",
  async () => {
    await withPinnedClock(async () => {
      const h = await loadHarness();
      h.tables.profiles = [profile()];
      const ip = freshIp();
      installAuth(h, {});
      h.userStatus = 503;
      const bearers = Array.from({ length: AUTH_FAILURE_LIMIT.limit }, (_, i) =>
        supabaseBearer(`outage-${i}`),
      );
      const outage = await repeat(AUTH_FAILURE_LIMIT.limit, (i) =>
        readMe(h.handler, ip, bearers[i]),
      );
      assertEquals(count(outage, 503), AUTH_FAILURE_LIMIT.limit, outage.join(","));
      assertEquals(await egressCharged(ip), 0);

      h.userStatus = 200;
      const recovered = await repeat(AUTH_FAILURE_LIMIT.limit, (i) =>
        readMe(h.handler, ip, bearers[i]),
      );
      assertEquals(count(recovered, 200), AUTH_FAILURE_LIMIT.limit, recovered.join(","));
      const novel = await readMe(h.handler, ip, fakeSupabaseAccessToken(OTHER_USER_ID));
      assertEquals(novel.status, 200);
    });
  },
);

// ─── ATTACK 10: bounded minted registry — eviction under a co-tenant flood ───

Deno.test(
  "ATTACK 10 (registry eviction): a venue's minted bearer is still admitted under stuffing after 50,000 other sessions were minted on the isolate",
  async () => {
    await withPinnedClock(async () => {
      const { rateLimit } = await loadIsolate();
      const budget = AUTH_FAILURE_LIMIT;
      const ip = "203.0.113.154";
      const venueBearer = `minted.${crypto.randomUUID()}.sig`;
      await rateLimit.noteMintedCredential(venueBearer, 3_600);
      for (let i = 0; i < 50_000; i += 1) {
        await rateLimit.noteMintedCredential(`other-${i}`, 3_600);
      }
      for (let i = 0; i < budget.limit; i += 1) {
        await rateLimit.chargeAuthFailure(
          "bearer",
          ip,
          await rateLimit.authFailureIdentity(`forged-${i}`),
          "credential",
          budget,
        );
      }
      const gate = await rateLimit.peekAuthFailureBudget(
        ip,
        await rateLimit.authFailureIdentity(venueBearer),
        budget,
      );
      assertEquals(gate.allowed, true, "the venue's live bearer was evicted and is now held");
    });
  },
);
