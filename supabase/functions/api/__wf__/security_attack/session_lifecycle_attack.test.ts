// Attack #2 — session lifecycle: replay, refresh-token reuse after rotation,
// logout-then-reuse (exact bearer, sibling bearer, racing bearer), the
// transitional provider-token branch, and expiry.
//
// Tests named `REPRO (defect):` pin behaviour that is observed and judged
// wrong against the documented contract (AGENTS.md "Auth sessions",
// index.ts logoutRoute doc comment). They pass while the defect exists so
// the artifact records the exact inputs; the coordinator decides severity.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  callEdge,
  edgeRequest,
  heapSnapshot,
  ipForIndex,
  loadAttackHarness,
  seedFromEnv,
  writeArtifact,
} from "./attackHarness.ts";
import { sha256Prefix } from "./fakeSupabase.ts";

const SEED = seedFromEnv();
const REPLAY_COUNT = Number(Deno.env.get("AUTH_ATTACK_REPLAY") ?? 200);

interface StepRecord {
  step: string;
  bearer: string | null;
  status: number;
  error: string | null;
  upstream: Array<{ method: string; path: string; bearer: string; status: number }>;
  reachedRest: boolean;
  note?: string;
}

const steps: StepRecord[] = [];
async function step(
  name: string,
  outcomePromise: Promise<import("./attackHarness.ts").EdgeOutcome>,
  bearer: string | null,
  note?: string,
): Promise<import("./attackHarness.ts").EdgeOutcome> {
  const outcome = await outcomePromise;
  steps.push({
    step: name,
    bearer: bearer ? await sha256Prefix(bearer) : null,
    status: outcome.status,
    error: outcome.error,
    upstream: outcome.upstreamCalls,
    reachedRest: outcome.reachedRest,
    note,
  });
  return outcome;
}

let userCounter = 0;
async function freshUser(provider: "google" | "apple" = "google") {
  const harness = await loadAttackHarness();
  userCounter += 1;
  const id = `0f4a6c8e-3333-4a2b-8c3d-${String(userCounter).padStart(12, "0")}`;
  const user = harness.fake.addUser({
    id,
    email: `user${userCounter}@example.test`,
    provider,
    providerSub: `${provider}-sub-${userCounter}`,
  });
  return user;
}

Deno.test("positive control: a legitimate access token authenticates and replays from cache", async () => {
  const harness = await loadAttackHarness();
  const user = await freshUser();
  const minted = await harness.fake.mintSession(user.id);
  const ip = ipForIndex(1, 20);

  const first = await step("legit.first", callEdge(harness, edgeRequest("GET", "/v1/me", { token: minted.accessToken, ip })), minted.accessToken);
  assertEquals(first.status, 200);
  assertEquals(first.upstreamCalls.filter((c) => c.path === "/auth/v1/user").length, 1);

  const getUserBefore = harness.fake.calls.filter((c) => c.path === "/auth/v1/user").length;
  const statuses: number[] = [];
  for (let i = 0; i < REPLAY_COUNT; i += 1) {
    const outcome = await callEdge(harness, edgeRequest("GET", "/v1/me", { token: minted.accessToken, ip }));
    statuses.push(outcome.status);
  }
  const getUserAfter = harness.fake.calls.filter((c) => c.path === "/auth/v1/user").length;
  steps.push({
    step: "legit.replay",
    bearer: await sha256Prefix(minted.accessToken),
    status: 200,
    error: null,
    upstream: [],
    reachedRest: true,
    note: `${REPLAY_COUNT} replays, statuses=${JSON.stringify(Object.entries(statuses.reduce<Record<number, number>>((acc, s) => ((acc[s] = (acc[s] ?? 0) + 1), acc), {})))}, extra getUser calls=${getUserAfter - getUserBefore}`,
  });
  // The per-user route budget (240 / 60 s) is a rate limit, not an auth
  // verdict: beyond it 429 is the only other acceptable answer.
  const USER_LIMIT = 240;
  statuses.forEach((status, i) => {
    if (i + 1 < USER_LIMIT) assertEquals(status, 200, `replay ${i} within budget`);
    else assert(status === 200 || status === 429, `replay ${i} → ${status}`);
  });
  assertEquals(getUserAfter - getUserBefore, 0, "replays are served from the verified-auth cache");
});

Deno.test("concurrent cold-cache replay: N parallel requests with one bearer", async () => {
  const harness = await loadAttackHarness();
  const user = await freshUser();
  const minted = await harness.fake.mintSession(user.id);
  const ip = ipForIndex(2, 20);
  const before = harness.fake.calls.filter((c) => c.path === "/auth/v1/user").length;
  const results = await Promise.all(
    Array.from({ length: 50 }, () => callEdge(harness, edgeRequest("GET", "/v1/me", { token: minted.accessToken, ip }))),
  );
  const after = harness.fake.calls.filter((c) => c.path === "/auth/v1/user").length;
  steps.push({
    step: "legit.parallel-cold",
    bearer: await sha256Prefix(minted.accessToken),
    status: 200,
    error: null,
    upstream: [],
    reachedRest: true,
    note: `50 parallel requests on a cold cache → ${after - before} getUser calls (no single-flight: every miss verifies)`,
  });
  assert(results.every((r) => r.status === 200));
});

Deno.test("refresh rotation: a rotated-away refresh token is refused, and the family dies", async () => {
  const harness = await loadAttackHarness();
  const user = await freshUser();
  const minted = await harness.fake.mintSession(user.id);
  const r0 = minted.session.currentRefreshToken;
  const ip = ipForIndex(3, 20);

  const rotate1 = await step("refresh.r0", callEdge(harness, edgeRequest("POST", "/v1/auth/refresh", { authorization: null, ip, body: { refreshToken: r0 } })), r0);
  assertEquals(rotate1.status, 200);
  const session1 = JSON.parse(rotate1.bodyText).session as { accessToken: string; refreshToken: string; expiresAt: number };
  assertNotEquals(session1.refreshToken, r0, "refresh token rotates");
  assertNotEquals(session1.accessToken, minted.accessToken);

  const reuse = await step("refresh.r0-reuse-after-rotation", callEdge(harness, edgeRequest("POST", "/v1/auth/refresh", { authorization: null, ip, body: { refreshToken: r0 } })), r0);
  assertEquals(reuse.status, 401, "reusing a rotated-away refresh token must be refused");

  // Reuse detection revoked the family upstream: the CURRENT refresh token
  // is now dead too …
  const afterReuse = await step("refresh.r1-after-family-revoke", callEdge(harness, edgeRequest("POST", "/v1/auth/refresh", { authorization: null, ip, body: { refreshToken: session1.refreshToken } })), session1.refreshToken);
  assertEquals(afterReuse.status, 401);
  // … and so is a never-cached access token from the revoked family.
  const a1 = await step("refresh.a1-after-family-revoke", callEdge(harness, edgeRequest("GET", "/v1/me", { token: session1.accessToken, ip })), session1.accessToken);
  assertEquals(a1.status, 401);
  assertEquals(a1.reachedRest, false);

  // Garbage / empty / non-string refresh tokens.
  for (const [label, body] of [
    ["refresh.empty", { refreshToken: "" }],
    ["refresh.whitespace", { refreshToken: "   " }],
    ["refresh.number", { refreshToken: 12345 }],
    ["refresh.object", { refreshToken: { $ne: null } }],
    ["refresh.unknown", { refreshToken: "0123456789abcdef0123456789abcdef" }],
    ["refresh.access-token-as-refresh", { refreshToken: session1.accessToken }],
  ] as Array<[string, unknown]>) {
    const outcome = await step(label, callEdge(harness, edgeRequest("POST", "/v1/auth/refresh", { authorization: null, ip: ipForIndex(steps.length, 21), body })), null);
    assert(outcome.status === 400 || outcome.status === 401, `${label} → ${outcome.status}`);
    assertEquals(outcome.reachedRest, false);
  }
});

Deno.test("logout-then-reuse (exact bearer): the logged-out access token and its refresh token are dead", async () => {
  const harness = await loadAttackHarness();
  const user = await freshUser();
  const minted = await harness.fake.mintSession(user.id);
  const ip = ipForIndex(4, 20);
  const warm = await step("logout.warm", callEdge(harness, edgeRequest("GET", "/v1/me", { token: minted.accessToken, ip })), minted.accessToken);
  assertEquals(warm.status, 200);
  const logout = await step("logout.call", callEdge(harness, edgeRequest("POST", "/v1/auth/logout", { token: minted.accessToken, ip })), minted.accessToken);
  assertEquals(logout.status, 204);
  const reuse = await step("logout.reuse-access-token", callEdge(harness, edgeRequest("GET", "/v1/me", { token: minted.accessToken, ip })), minted.accessToken);
  assertEquals(reuse.status, 401, "logged-out bearer must be refused");
  assertEquals(reuse.reachedRest, false);
  const refresh = await step("logout.reuse-refresh-token", callEdge(harness, edgeRequest("POST", "/v1/auth/refresh", { authorization: null, ip, body: { refreshToken: minted.session.currentRefreshToken } })), minted.session.currentRefreshToken);
  assertEquals(refresh.status, 401, "refresh token of a logged-out session must be refused");
  // Repeated logout with a dead bearer is refused at authenticate(), not 204.
  const again = await step("logout.repeat-with-dead-bearer", callEdge(harness, edgeRequest("POST", "/v1/auth/logout", { token: minted.accessToken, ip })), minted.accessToken);
  assertEquals(again.status, 401);
});

Deno.test("REPRO (defect): logout-then-reuse via a SIBLING bearer — an earlier access token of the same session survives logout in the auth cache", async () => {
  const harness = await loadAttackHarness();
  const user = await freshUser();
  const minted = await harness.fake.mintSession(user.id);
  const a1 = minted.accessToken;
  const ip = ipForIndex(5, 20);

  // Device uses A1 (now cached), rotates to A2 (as the app does 60 s before
  // expiry, or at once after any 401), then signs out with A2.
  const useA1 = await step("sibling.use-a1", callEdge(harness, edgeRequest("GET", "/v1/me", { token: a1, ip })), a1);
  assertEquals(useA1.status, 200);
  const rotated = await step("sibling.rotate", callEdge(harness, edgeRequest("POST", "/v1/auth/refresh", { authorization: null, ip, body: { refreshToken: minted.session.currentRefreshToken } })), null);
  assertEquals(rotated.status, 200);
  const a2 = (JSON.parse(rotated.bodyText).session as { accessToken: string }).accessToken;
  const logout = await step("sibling.logout-with-a2", callEdge(harness, edgeRequest("POST", "/v1/auth/logout", { token: a2, ip })), a2);
  assertEquals(logout.status, 204);
  assertEquals(harness.fake.sessions.get(minted.session.id)?.revoked, true, "upstream session is revoked");

  // Upstream now refuses A1 (session_not_found) — the edge must too.
  const upstreamView = await harness.fake.verifyAccessToken(a1, { requireLiveSession: true });
  assertEquals(upstreamView.ok, false);

  const reuseA1 = await step(
    "sibling.reuse-a1-after-logout",
    callEdge(harness, edgeRequest("GET", "/v1/me", { token: a1, ip })),
    a1,
    "EXPECTED 401 (session revoked upstream); OBSERVED below",
  );
  const reuseA2 = await step("sibling.reuse-a2-after-logout", callEdge(harness, edgeRequest("GET", "/v1/me", { token: a2, ip })), a2);
  assertEquals(reuseA2.status, 401, "the bearer used for logout is evicted");

  // Defect pin: A1 is still served from the verified-auth cache without any
  // upstream check, and the data plane is reached with a revoked session's
  // JWT (PostgREST only checks signature + exp).
  assertEquals(reuseA1.status, 200, "REPRO: sibling bearer accepted after logout (fix ⇒ flip to 401)");
  assertEquals(reuseA1.consultedAuth, false, "REPRO: served from cache, upstream never asked");
  assertEquals(reuseA1.reachedRest, true, "REPRO: data plane reached with revoked session");
});

Deno.test("REPRO (defect): logout evicts the cache BEFORE revoking upstream — a request in that window re-caches the revoked bearer for up to 10 min", async () => {
  const harness = await loadAttackHarness();
  const user = await freshUser();
  const minted = await harness.fake.mintSession(user.id);
  const a = minted.accessToken;
  const victimIp = ipForIndex(6, 20);
  const attackerIp = ipForIndex(7, 20);

  const warm = await step("race.warm", callEdge(harness, edgeRequest("GET", "/v1/me", { token: a, ip: victimIp })), a);
  assertEquals(warm.status, 200);

  // Hold the upstream logout call open; while it is pending the edge has
  // already run cacheDel (logoutRoute: cacheDel THEN fetch logout).
  let releaseLogout: () => void = () => {};
  const logoutGate = new Promise<void>((resolve) => (releaseLogout = resolve));
  let logoutReached: () => void = () => {};
  const logoutReachedPromise = new Promise<void>((resolve) => (logoutReached = resolve));
  const realLogout = harness.fake.overrides.logout;
  harness.fake.overrides.logout = async (request) => {
    logoutReached();
    await logoutGate;
    // Perform the real revocation.
    const token = (request.headers.get("Authorization") ?? "").slice(7).trim();
    const verified = await harness.fake.verifyAccessToken(token, { requireLiveSession: true });
    if (verified.ok && verified.sessionId) harness.fake.sessions.get(verified.sessionId)!.revoked = true;
    return new Response(null, { status: 204 });
  };

  const logoutPromise = callEdge(harness, edgeRequest("POST", "/v1/auth/logout", { token: a, ip: victimIp }));
  await logoutReachedPromise;
  // Attacker (holding a copy of A) sends ONE request while the victim's
  // logout is in flight: cache miss → getUser succeeds (session not yet
  // revoked) → the edge writes A back into the cache.
  const attackerDuring = await step("race.attacker-during-logout", callEdge(harness, edgeRequest("GET", "/v1/me", { token: a, ip: attackerIp })), a);
  releaseLogout();
  const logout = await step("race.logout-completes", logoutPromise, a);
  harness.fake.overrides.logout = realLogout;
  assertEquals(logout.status, 204);
  assertEquals(harness.fake.sessions.get(minted.session.id)?.revoked, true);
  assertEquals(attackerDuring.status, 200);

  // AFTER the victim received 204, the revoked bearer keeps working from cache.
  const after = await step(
    "race.attacker-after-logout",
    callEdge(harness, edgeRequest("GET", "/v1/me", { token: a, ip: attackerIp })),
    a,
    "EXPECTED 401 after a completed logout; OBSERVED below",
  );
  assertEquals(after.status, 200, "REPRO: revoked bearer accepted after logout completed (fix ⇒ flip to 401)");
  assertEquals(after.consultedAuth, false, "REPRO: served from the re-populated cache");
  assertEquals(after.reachedRest, true);
});

Deno.test("REPRO (defect): transitional provider-token branch — logout is a no-op for a provider ID token bearer and every cache miss mints an orphan session", async () => {
  const harness = await loadAttackHarness();
  const user = await freshUser("google");
  const idToken = await harness.fake.providerIdToken("google", user.providerSub);
  const ip = ipForIndex(8, 20);
  const sessionsBefore = harness.fake.sessions.size;
  const exchangesBefore = harness.fake.idTokenExchanges;

  // Any route, not just bootstrap, accepts the raw provider token.
  const first = await step("provider.first-use", callEdge(harness, edgeRequest("GET", "/v1/me", { token: idToken, ip })), idToken);
  assertEquals(first.status, 200);
  assertEquals(harness.fake.idTokenExchanges - exchangesBefore, 1, "a Supabase session was minted for a non-bootstrap route");
  const replays: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    replays.push((await callEdge(harness, edgeRequest("GET", "/v1/me/access", { token: idToken, ip }))).status);
  }
  assert(replays.every((s) => s === 200 || s === 503), `replays: ${replays.join(",")}`);
  assertEquals(harness.fake.idTokenExchanges - exchangesBefore, 1, "replays hit the cache, no further exchanges");

  const logout = await step("provider.logout", callEdge(harness, edgeRequest("POST", "/v1/auth/logout", { token: idToken, ip })), idToken);
  assertEquals(logout.status, 204, "logout reports success");
  const upstreamLogout = logout.upstreamCalls.find((c) => c.path.startsWith("/auth/v1/logout"));
  assertEquals(upstreamLogout?.status, 401, "upstream refused the provider token as a session bearer — the minted session was never revoked");
  const orphan = [...harness.fake.sessions.values()].filter((s) => s.userId === user.id);
  assertEquals(orphan.length, 1);
  assertEquals(orphan[0].revoked, false, "REPRO: session minted by the transitional branch survives logout");

  const reuse = await step(
    "provider.reuse-after-logout",
    callEdge(harness, edgeRequest("GET", "/v1/me", { token: idToken, ip })),
    idToken,
    "EXPECTED 401 after logout; OBSERVED below",
  );
  assertEquals(reuse.status, 200, "REPRO: provider token still authenticates after logout (fix ⇒ 401 or remove branch)");
  assertEquals(harness.fake.idTokenExchanges - exchangesBefore, 2, "REPRO: logout+reuse minted a SECOND orphan session");
  assertEquals(harness.fake.sessions.size - sessionsBefore, 2);

  // Provider token for a subject nobody has bootstrapped: the transitional
  // branch auto-provisions the account on a plain GET (bootstrap's
  // Apple-revocation-credential capture is skipped entirely).
  const usersBefore = harness.fake.users.size;
  const stranger = await harness.fake.providerIdToken("apple", "apple-never-bootstrapped");
  const created = await step("provider.stranger-auto-provisioned", callEdge(harness, edgeRequest("GET", "/v1/me", { token: stranger, ip: ipForIndex(9, 20) })), stranger);
  assertEquals(created.status, 200);
  assertEquals(harness.fake.users.size - usersBefore, 1, "REPRO: account created outside bootstrap");
});

Deno.test("expiry: an access token past exp is refused locally without consulting upstream", async () => {
  const harness = await loadAttackHarness();
  const user = await freshUser();
  harness.fake.accessTokenTtlSeconds = 1;
  const minted = await harness.fake.mintSession(user.id);
  harness.fake.accessTokenTtlSeconds = 3600;
  const ip = ipForIndex(10, 20);
  const live = await step("expiry.live", callEdge(harness, edgeRequest("GET", "/v1/me", { token: minted.accessToken, ip })), minted.accessToken);
  assertEquals(live.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const dead = await step("expiry.after-exp", callEdge(harness, edgeRequest("GET", "/v1/me", { token: minted.accessToken, ip })), minted.accessToken);
  assertEquals(dead.status, 401);
  assertEquals(dead.consultedAuth, false, "expired bearer is refused before any upstream call");
  assertEquals(dead.reachedRest, false);
});

Deno.test("deleted account: a bearer whose user was deleted upstream is refused once its cache entry is gone", async () => {
  const harness = await loadAttackHarness();
  const user = await freshUser();
  const minted = await harness.fake.mintSession(user.id);
  const ip = ipForIndex(11, 20);
  // Never cached: deleted before first use.
  user.deleted = true;
  const outcome = await step("deleted.cold", callEdge(harness, edgeRequest("GET", "/v1/me", { token: minted.accessToken, ip })), minted.accessToken);
  assertEquals(outcome.status, 401);
  assertEquals(outcome.reachedRest, false);
});

Deno.test("artifact: session lifecycle steps", async () => {
  await writeArtifact("session_lifecycle.json", {
    seed: SEED,
    replayCount: REPLAY_COUNT,
    heap: heapSnapshot(),
    steps,
  });
});
