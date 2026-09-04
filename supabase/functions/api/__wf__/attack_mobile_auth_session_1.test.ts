// Adversarial pass 3 — `mobile-auth-session`, edge half (against 4d812e1a).
//
// Attacks on POST /v1/auth/refresh input handling + auth-failure budget
// charging, and on POST /v1/me/delete-confirm ownership (a challenge minted
// for one canonical user presented by another). Black-box through the real
// handler with a local fake Supabase (GoTrue + PostgREST) — no real project
// is touched. Cases named `REPRO:` pin what the function does TODAY.
//
// Run from the repo root:
//   deno test -A --no-check --config supabase/functions/api/__wf__/deno.json \
//     supabase/functions/api/__wf__/attack_mobile_auth_session_1.test.ts

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { peekRateLimit } from "../rateLimit.ts";

// ─── Fake Supabase ───────────────────────────────────────────────────────────

interface DeletionRow {
  user_id: string;
  challenge: string;
  created_at: string;
  expires_at: string;
}

interface FakeState {
  /** Refresh tokens GoTrue accepts → the user they belong to. */
  validRefreshTokens: Map<string, string>;
  /** Every refresh_token GoTrue was asked to rotate, verbatim. */
  refreshTokensSeen: string[];
  /** Force GoTrue's refresh grant to answer this status (0 = normal). */
  refreshGrantStatus: number;
  deletionRows: DeletionRow[];
  /** Query strings PostgREST received for account_deletion_requests GETs. */
  deletionSelects: string[];
  adminDeleteCalls: string[];
  revenueCatDeleteCalls: number;
}

const state: FakeState = {
  validRefreshTokens: new Map(),
  refreshTokensSeen: [],
  refreshGrantStatus: 0,
  deletionRows: [],
  deletionSelects: [],
  adminDeleteCalls: [],
  revenueCatDeleteCalls: 0,
};

function resetState(): void {
  state.validRefreshTokens = new Map();
  state.refreshTokensSeen = [];
  state.refreshGrantStatus = 0;
  state.deletionRows = [];
  state.deletionSelects = [];
  state.adminDeleteCalls = [];
  state.revenueCatDeleteCalls = 0;
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const b64url = (input: string): string =>
  btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Unsigned JWT-shaped provider token; verification is delegated to the fake. */
function providerToken(sub: string): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub,
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    }),
  );
  return `${header}.${payload}.sig`;
}

function sessionFor(userId: string, refreshToken: string) {
  return {
    access_token: `sb-access-${userId}`,
    token_type: "bearer",
    expires_in: 3_600,
    expires_at: Math.floor(Date.now() / 1_000) + 3_600,
    refresh_token: refreshToken,
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: "u@example.com",
    },
  };
}

async function fakeSupabase(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "POST" && path === "/auth/v1/token") {
    const grant = url.searchParams.get("grant_type");
    if (grant === "refresh_token") {
      const body = (await request.json()) as { refresh_token?: unknown };
      const token = String(body.refresh_token);
      state.refreshTokensSeen.push(token);
      if (state.refreshGrantStatus) {
        return jsonResponse(state.refreshGrantStatus, {
          code: state.refreshGrantStatus,
          msg: "upstream trouble",
        });
      }
      const owner = state.validRefreshTokens.get(token);
      if (!owner) {
        return jsonResponse(400, {
          error: "invalid_grant",
          error_description: "Invalid Refresh Token: Refresh Token Not Found",
        });
      }
      state.validRefreshTokens.delete(token);
      const rotated = `rotated-${crypto.randomUUID()}`;
      state.validRefreshTokens.set(rotated, owner);
      return jsonResponse(200, sessionFor(owner, rotated));
    }
    const body = (await request.json()) as { id_token: string };
    const payloadSegment = body.id_token.split(".")[1];
    const claims = JSON.parse(
      atob(payloadSegment.replace(/-/g, "+").replace(/_/g, "/")),
    ) as {
      sub: string;
    };
    return jsonResponse(
      200,
      sessionFor(claims.sub, `sb-refresh-${claims.sub}`),
    );
  }

  if (request.method === "DELETE" && path.startsWith("/auth/v1/admin/users/")) {
    const userId = path.slice("/auth/v1/admin/users/".length);
    state.adminDeleteCalls.push(userId);
    // auth.users → profiles → account_deletion_requests cascades
    // (20260831000000_scale_and_security.sql: `on delete cascade`).
    state.deletionRows = state.deletionRows.filter((r) => r.user_id !== userId);
    return jsonResponse(200, {});
  }

  if (path === "/rest/v1/account_deletion_requests") {
    if (request.method === "POST") {
      const row = (await request.json()) as DeletionRow;
      state.deletionRows = state.deletionRows.filter((r) =>
        r.user_id !== row.user_id
      );
      state.deletionRows.push(row);
      return new Response(null, { status: 201 });
    }
    if (request.method === "GET") {
      state.deletionSelects.push(url.search);
      // The route filters `.eq("user_id", authed.id)`; RLS would do the same.
      const filter = url.searchParams.get("user_id");
      const userId = filter?.startsWith("eq.") ? filter.slice(3) : null;
      const rows = state.deletionRows.filter((r) =>
        userId === null || r.user_id === userId
      );
      return jsonResponse(
        200,
        rows.map(({ challenge, created_at, expires_at }) => ({
          challenge,
          created_at,
          expires_at,
        })),
      );
    }
    if (request.method === "DELETE") {
      const filter = url.searchParams.get("user_id");
      const userId = filter?.startsWith("eq.") ? filter.slice(3) : null;
      state.deletionRows = state.deletionRows.filter((r) =>
        r.user_id !== userId
      );
      return new Response(null, { status: 204 });
    }
  }

  if (path === "/rest/v1/account_external_credentials") {
    if (request.method === "GET") return jsonResponse(200, []);
    return new Response(null, { status: 201 });
  }
  if (path === "/rest/v1/profiles" && request.method === "GET") {
    return jsonResponse(200, []);
  }
  if (path === "/rest/v1/rpc/access_state" && request.method === "POST") {
    return jsonResponse(200, [{
      premium: false,
      scored_count: 0,
      reserved_count: 0,
    }]);
  }
  if (path.startsWith("/rest/v1/")) {
    if (request.method === "GET") return jsonResponse(200, []);
    return new Response(null, { status: 204 });
  }
  return jsonResponse(404, {
    message: `fake supabase: unhandled ${request.method} ${path}`,
  });
}

// ─── Boot the Edge Function in-process ───────────────────────────────────────

const fake = Deno.serve({ port: 0, onListen: () => undefined }, fakeSupabase);
const fakeUrl = `http://127.0.0.1:${fake.addr.port}`;

Deno.env.set("SUPABASE_URL", fakeUrl);
Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_revenuecat");
Deno.env.delete("UPSTASH_REDIS_REST_URL");
Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  if (request.url.startsWith("https://api.revenuecat.com/v1/subscribers/")) {
    state.revenueCatDeleteCalls += 1;
    return Promise.resolve(new Response(null, { status: 200 }));
  }
  if (!request.url.startsWith(fakeUrl)) {
    return Promise.reject(
      new Error(`test sandbox: refused network egress to ${request.url}`),
    );
  }
  return realFetch(input, init);
}) as typeof fetch;

type Handler = (request: Request) => Promise<Response> | Response;
let handler: Handler | null = null;
const realServe = Deno.serve;
(Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
  handler = (typeof args[0] === "function" ? args[0] : args[1]) as Handler;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
};
await import("../index.ts");
(Deno as unknown as { serve: unknown }).serve = realServe;
if (!handler) throw new Error("index.ts did not register a Deno.serve handler");
const api: Handler = handler;

const EDGE = "http://edge.local/functions/v1/api";

/** Distinct client IP per test so the fixed-window budgets never bleed. */
let ipCounter = 0;
const nextIp = (): string => `198.51.100.${(ipCounter += 1)}`;

const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
const AUTH_REFRESH_LIMIT = { limit: 30, windowSeconds: 60 };
const authFailuresCharged = async (ip: string): Promise<number> =>
  AUTH_FAILURE_LIMIT.limit -
  (await peekRateLimit(
    "authfail",
    ip,
    AUTH_FAILURE_LIMIT.limit,
    AUTH_FAILURE_LIMIT.windowSeconds,
  ))
    .remaining;
const refreshHitsCharged = async (ip: string): Promise<number> =>
  AUTH_REFRESH_LIMIT.limit -
  (await peekRateLimit(
    "auth_refresh",
    ip,
    AUTH_REFRESH_LIMIT.limit,
    AUTH_REFRESH_LIMIT.windowSeconds,
  )).remaining;

function refreshRequest(
  ip: string,
  body: BodyInit | null,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    api(
      new Request(`${EDGE}/v1/auth/refresh`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": ip,
          ...headers,
        },
        body,
      }),
    ),
  );
}

const refresh = (ip: string, body: unknown) =>
  refreshRequest(ip, JSON.stringify(body));

const call = (
  method: string,
  path: string,
  token: string,
  body?: unknown,
  ip = "203.0.113.77",
): Promise<Response> =>
  Promise.resolve(
    api(
      new Request(`${EDGE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-forwarded-for": ip,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  );

const errorCode = async (res: Response): Promise<string | undefined> =>
  ((await res.json()) as { error?: { code?: string } }).error?.code;

// ─── S5: refresh with hostile bodies + auth-failure budget ───────────────────

Deno.test("S5 baseline: a bogus refresh token → 401, charges ONE auth failure and one auth_refresh hit", async () => {
  resetState();
  const ip = nextIp();
  const res = await refresh(ip, { refreshToken: "not-a-real-token" });
  assertEquals(res.status, 401);
  await res.body?.cancel();
  assertEquals(state.refreshTokensSeen, ["not-a-real-token"]);
  assertEquals(await authFailuresCharged(ip), 1);
  assertEquals(await refreshHitsCharged(ip), 1);
});

Deno.test("S5: refreshToken: ['x'] → 400 validation.refresh, never reaches Supabase Auth, and does NOT charge the auth-failure budget", async () => {
  resetState();
  const ip = nextIp();
  const res = await refresh(ip, { refreshToken: ["x"] });
  assertEquals(res.status, 400);
  assertEquals(await errorCode(res), "validation.refresh");
  assertEquals(state.refreshTokensSeen, []);
  assertEquals(await authFailuresCharged(ip), 0);
  // …but it does spend the per-IP auth_refresh budget (30/min), which is
  // the only throttle on malformed refresh bodies.
  assertEquals(await refreshHitsCharged(ip), 1);
});

Deno.test("S5: every non-string / blank refreshToken shape is a 400 with no Supabase call and no auth-failure charge", async () => {
  resetState();
  const ip = nextIp();
  const shapes: unknown[] = [
    { refreshToken: "" },
    { refreshToken: "   \n\t" },
    { refreshToken: 42 },
    { refreshToken: null },
    { refreshToken: { token: "x" } },
    { refreshToken: true },
    {},
    [],
    '"just a string"',
    null,
  ];
  for (const shape of shapes) {
    const res = await refresh(ip, shape);
    assertEquals(res.status, 400, `shape ${JSON.stringify(shape)}`);
    assertEquals(await errorCode(res), "validation.refresh");
  }
  const notJson = await refreshRequest(ip, "{not json");
  assertEquals(notJson.status, 400);
  await notJson.body?.cancel();
  const empty = await refreshRequest(ip, null);
  assertEquals(empty.status, 400);
  await empty.body?.cancel();
  assertEquals(state.refreshTokensSeen, []);
  assertEquals(await authFailuresCharged(ip), 0);
  assertEquals(await refreshHitsCharged(ip), shapes.length + 2);
});

Deno.test("S5: a 5 kB refreshToken is accepted as input (under the 5 MB body cap), forwarded verbatim to Supabase Auth, answered 401 and charged like any other bad token", async () => {
  resetState();
  const ip = nextIp();
  const token = "k".repeat(5_000);
  const res = await refresh(ip, { refreshToken: token });
  assertEquals(res.status, 401);
  await res.body?.cancel();
  assertEquals(state.refreshTokensSeen.length, 1);
  assertEquals(state.refreshTokensSeen[0].length, 5_000);
  assertEquals(state.refreshTokensSeen[0], token);
  assertEquals(await authFailuresCharged(ip), 1);
  assertEquals(await refreshHitsCharged(ip), 1);
});

Deno.test("S5: a 5 kB token padded with whitespace is trimmed before the grant; a 5 kB unicode token survives byte-for-byte", async () => {
  resetState();
  const ip = nextIp();
  const padded = `  ${"k".repeat(5_000)}\n`;
  const res = await refresh(ip, { refreshToken: padded });
  assertEquals(res.status, 401);
  await res.body?.cancel();
  assertEquals(state.refreshTokensSeen, [padded.trim()]);

  const unicode = "🥒é\u0000".repeat(1_000);
  const res2 = await refresh(ip, { refreshToken: unicode });
  assertEquals(res2.status, 401);
  await res2.body?.cancel();
  assertEquals(state.refreshTokensSeen[1], unicode);
  assertEquals(await authFailuresCharged(ip), 2);
});

Deno.test("S5: a 1 MB refreshToken is still under the body cap → forwarded to Supabase Auth in full (no per-field size cap on refresh)", async () => {
  resetState();
  const ip = nextIp();
  const token = "m".repeat(1_000_000);
  const res = await refresh(ip, { refreshToken: token });
  assertEquals(res.status, 401);
  await res.body?.cancel();
  assertEquals(state.refreshTokensSeen.length, 1);
  assertEquals(state.refreshTokensSeen[0].length, 1_000_000);
  assertEquals(await authFailuresCharged(ip), 1);
});

Deno.test("S5: a body over MAX_JSON_BODY_BYTES (5 MB) declared by Content-Length → 413 before any auth work; no budget of any kind is charged", async () => {
  resetState();
  const ip = nextIp();
  const res = await refreshRequest(ip, JSON.stringify({ refreshToken: "x" }), {
    "content-length": String(5_000_001),
  });
  assertEquals(res.status, 413);
  await res.body?.cancel();
  assertEquals(state.refreshTokensSeen, []);
  assertEquals(await authFailuresCharged(ip), 0);
  assertEquals(await refreshHitsCharged(ip), 0);
});

Deno.test("S5: a streamed body over 5 MB WITHOUT Content-Length → 413 (the reader bounds it), auth-failure budget untouched", async () => {
  resetState();
  const ip = nextIp();
  const chunk = new TextEncoder().encode("y".repeat(1_000_000));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"refreshToken":"'));
      for (let i = 0; i < 6; i += 1) controller.enqueue(chunk);
      controller.enqueue(new TextEncoder().encode('"}'));
      controller.close();
    },
  });
  const request = new Request(`${EDGE}/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: stream,
  });
  assertEquals(request.headers.get("content-length"), null);
  const res = await api(request);
  assertEquals(res.status, 413);
  await res.body?.cancel();
  assertEquals(state.refreshTokensSeen, []);
  assertEquals(await authFailuresCharged(ip), 0);
  // The auth_refresh hit is counted before the body is read.
  assertEquals(await refreshHitsCharged(ip), 1);
});

Deno.test("S5: Supabase Auth 5xx on refresh → 503 generic body, NOT charged as an auth failure (and note how long the client retry loop holds the request)", async () => {
  resetState();
  const ip = nextIp();
  state.refreshGrantStatus = 502;
  const startedAt = performance.now();
  const res = await refresh(ip, { refreshToken: "whatever" });
  const elapsedMs = Math.round(performance.now() - startedAt);
  assertEquals(res.status, 503);
  const body = await res.text();
  assert(!body.includes("upstream trouble"), "5xx detail must not leak");
  assertEquals(await authFailuresCharged(ip), 0);
  console.log(
    `[attack] refresh with GoTrue 502: ${elapsedMs} ms, ${state.refreshTokensSeen.length} upstream attempts`,
  );
});

Deno.test("S5: a valid refresh token rotates (200, new refresh token, no auth-failure charge); replaying the spent token is a 401 that IS charged", async () => {
  resetState();
  const ip = nextIp();
  const userId = crypto.randomUUID();
  state.validRefreshTokens.set("good-token", userId);
  const res = await refresh(ip, { refreshToken: "good-token" });
  assertEquals(res.status, 200);
  const body = (await res.json()) as {
    session: { accessToken: string; refreshToken: string; expiresAt: number };
  };
  assertEquals(body.session.accessToken, `sb-access-${userId}`);
  assertStringIncludes(body.session.refreshToken, "rotated-");
  assert(body.session.expiresAt > Date.now() / 1_000);
  assertEquals(await authFailuresCharged(ip), 0);

  const replay = await refresh(ip, { refreshToken: "good-token" });
  assertEquals(replay.status, 401);
  await replay.body?.cancel();
  assertEquals(await authFailuresCharged(ip), 1);
});

Deno.test("S5: 30 auth failures on one IP trip the pre-auth gate: the 31st refresh (even a VALID token) is refused 429 before reaching Supabase Auth", async () => {
  resetState();
  const ip = nextIp();
  for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
    // Alternate IPs are NOT used: this is one attacker. Stay under the
    // 30/min auth_refresh budget by mixing in bad bearers on another route.
    const res = i % 2 === 0
      ? await refresh(ip, { refreshToken: `bad-${i}` })
      : await call("GET", "/v1/me", `bad-bearer-${i}`, undefined, ip);
    assertEquals(res.status, 401, `attempt ${i}`);
    await res.body?.cancel();
  }
  assertEquals(await authFailuresCharged(ip), AUTH_FAILURE_LIMIT.limit);
  const seenBefore = state.refreshTokensSeen.length;
  state.validRefreshTokens.set("victim-token", crypto.randomUUID());
  const gated = await refresh(ip, { refreshToken: "victim-token" });
  assertEquals(gated.status, 429);
  assertEquals(gated.headers.get("RateLimit-Remaining"), "0");
  await gated.body?.cancel();
  assertEquals(state.refreshTokensSeen.length, seenBefore);
  // 400-validation bodies never contributed to that count.
  const malformed = await refresh(nextIp(), { refreshToken: ["x"] });
  assertEquals(malformed.status, 400);
  await malformed.body?.cancel();
});

Deno.test("S5: 30 malformed (400) refresh bodies exhaust the auth_refresh budget → the 31st is 429 (malformed input is throttled, just on a different budget than 401)", async () => {
  resetState();
  const ip = nextIp();
  for (let i = 0; i < AUTH_REFRESH_LIMIT.limit; i += 1) {
    const res = await refresh(ip, { refreshToken: ["x"] });
    assertEquals(res.status, 400);
    await res.body?.cancel();
  }
  const res = await refresh(ip, { refreshToken: ["x"] });
  assertEquals(res.status, 429);
  await res.body?.cancel();
  assertEquals(await authFailuresCharged(ip), 0);
});

// ─── S6: delete-confirm with a challenge minted for another canonical id ─────

const pastIso = (msAgo: number): string =>
  new Date(Date.now() - msAgo).toISOString();

async function mintChallenge(userId: string): Promise<string> {
  const res = await call(
    "POST",
    "/v1/me/delete-request",
    providerToken(userId),
  );
  assertEquals(res.status, 200);
  const { challenge } = (await res.json()) as { challenge: string };
  // Age the row past the 3-second review floor so only ownership decides.
  for (const row of state.deletionRows) {
    if (row.user_id === userId) row.created_at = pastIso(10_000);
  }
  return challenge;
}

Deno.test("S6: user B confirming with user A's live challenge → 403 account.deletion_challenge_invalid, nothing deleted for either user", async () => {
  resetState();
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const challengeA = await mintChallenge(userA);

  const res = await call(
    "POST",
    "/v1/me/delete-confirm",
    providerToken(userB),
    {
      challenge: challengeA,
    },
  );
  assertEquals(res.status, 403);
  const body = (await res.json()) as {
    error: { code: string; message: string };
  };
  assertEquals(body.error.code, "account.deletion_challenge_invalid");
  // The lookup was scoped to the CALLER, so A's row was never even compared.
  assertEquals(state.deletionSelects.length, 1);
  assertStringIncludes(state.deletionSelects[0], `user_id=eq.${userB}`);
  assertEquals(state.adminDeleteCalls, []);
  assertEquals(state.revenueCatDeleteCalls, 0);
  // A's request is intact and still confirmable by A.
  assertEquals(state.deletionRows.map((r) => r.user_id), [userA]);
  const own = await call(
    "POST",
    "/v1/me/delete-confirm",
    providerToken(userA),
    {
      challenge: challengeA,
    },
  );
  assertEquals(own.status, 200);
  assertEquals(((await own.json()) as { deleted: boolean }).deleted, true);
  assertEquals(state.adminDeleteCalls, [userA]);
});

Deno.test("S6: user B with their OWN pending request still cannot spend A's challenge (mismatch → 403), and B's own request survives", async () => {
  resetState();
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const challengeA = await mintChallenge(userA);
  const challengeB = await mintChallenge(userB);
  const res = await call(
    "POST",
    "/v1/me/delete-confirm",
    providerToken(userB),
    {
      challenge: challengeA,
    },
  );
  assertEquals(res.status, 403);
  assertEquals(await errorCode(res), "account.deletion_challenge_invalid");
  assertEquals(state.adminDeleteCalls, []);
  assertEquals(
    state.deletionRows.find((r) => r.user_id === userB)?.challenge,
    challengeB,
  );
});

Deno.test("S6: the 403 is what the mobile client classifies as non-retryable (not 401/429/5xx) — retrying the same challenge stays 403 and still deletes nothing", async () => {
  resetState();
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const challengeA = await mintChallenge(userA);
  for (let i = 0; i < 5; i += 1) {
    const res = await call(
      "POST",
      "/v1/me/delete-confirm",
      providerToken(userB),
      {
        challenge: challengeA,
      },
    );
    assertEquals(res.status, 403);
    await res.body?.cancel();
  }
  assertEquals(state.adminDeleteCalls, []);
  assertEquals(state.revenueCatDeleteCalls, 0);
  assertEquals(state.deletionRows.length, 1);
});

Deno.test("S6: a challenge with a different Unicode/case spelling of A's UUID is not a match either (400 for non-UUID, 403 for a UUID that is not the row)", async () => {
  resetState();
  const userA = crypto.randomUUID();
  const challengeA = await mintChallenge(userA);
  const tokenA = providerToken(userA);
  const upper = await call("POST", "/v1/me/delete-confirm", tokenA, {
    challenge: challengeA.toUpperCase(),
  });
  // Either the validator refuses the casing (400) or the equality does (403);
  // both are non-retryable to the client and neither deletes.
  assert(
    upper.status === 400 || upper.status === 403,
    `status ${upper.status}`,
  );
  await upper.body?.cancel();
  const fullwidth = await call("POST", "/v1/me/delete-confirm", tokenA, {
    challenge: challengeA.replace(/-/g, "\uFF0D"),
  });
  assertEquals(fullwidth.status, 400);
  await fullwidth.body?.cancel();
  const asArray = await call("POST", "/v1/me/delete-confirm", tokenA, {
    challenge: [challengeA],
  });
  assertEquals(asArray.status, 400);
  await asArray.body?.cancel();
  assertEquals(state.adminDeleteCalls, []);
});

Deno.test("S6: A's confirmation cannot be replayed after A is deleted (row gone → 403) and B's account is never touched", async () => {
  resetState();
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const challengeA = await mintChallenge(userA);
  await mintChallenge(userB);
  const first = await call(
    "POST",
    "/v1/me/delete-confirm",
    providerToken(userA),
    {
      challenge: challengeA,
    },
  );
  assertEquals(first.status, 200);
  await first.body?.cancel();
  const replayByB = await call(
    "POST",
    "/v1/me/delete-confirm",
    providerToken(userB),
    {
      challenge: challengeA,
    },
  );
  assertEquals(replayByB.status, 403);
  await replayByB.body?.cancel();
  assertEquals(state.adminDeleteCalls, [userA]);
  assertEquals(state.deletionRows.map((r) => r.user_id), [userB]);
});

Deno.test("teardown: fake Supabase", async () => {
  await fake.shutdown();
});
