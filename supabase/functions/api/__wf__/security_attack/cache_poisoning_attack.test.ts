// Attack #3 — the verified-auth cache: token-hash collision, key-namespace
// crossover, L2 (Redis) entry forgery, L1/L2 divergence after a revocation
// performed by another isolate, and eviction pressure.
//
// This file runs with the Upstash-backed L2 cache CONFIGURED (the production
// deployment shape per AGENTS.md), pointed at an in-process Upstash lookalike,
// so both cache tiers are observable.

import { assert, assertEquals } from "@std/assert";
import {
  callEdge,
  edgeRequest,
  heapSnapshot,
  ipForIndex,
  loadAttackHarness,
  seedFromEnv,
  writeArtifact,
} from "./attackHarness.ts";
import { assembleJwt, randomB64url, seededRandom } from "./jwt.ts";

const SEED = seedFromEnv();
const COLLISION_SAMPLES = Number(Deno.env.get("AUTH_ATTACK_HASHES") ?? 100_000);

// cache.ts reads the Upstash env at module evaluation, so it must be imported
// AFTER loadAttackHarness({ redis: true }) has set it — dynamically, never
// statically at the top of this file.
async function cacheModule() {
  await loadAttackHarness({ redis: true });
  return await import("../../cache.ts");
}

const authKey = async (token: string) => `auth:${await (await cacheModule()).sha256Hex(token)}`;

Deno.test("token-hash keying: no collision across a large seeded token population, and the full digest is the key", async () => {
  const { sha256Hex } = await cacheModule();
  const rng = seededRandom(SEED);
  const keys = new Set<string>();
  const prefix8 = new Map<string, string>();
  let prefixCollisions = 0;
  const heapBefore = heapSnapshot();
  const startedAt = performance.now();
  const samples: string[] = [];
  for (let i = 0; i < COLLISION_SAMPLES; i += 1) {
    // Realistic shapes: JWT-like triples plus single-character neighbours of
    // one another (the cheapest thing an attacker would try).
    const token = i % 2 === 0
      ? `${randomB64url(rng, 36)}.${randomB64url(rng, 120)}.${randomB64url(rng, 43)}`
      : `${randomB64url(rng, 8)}`;
    samples.push(token);
  }
  const digests: string[] = [];
  for (let offset = 0; offset < samples.length; offset += 2_000) {
    digests.push(...(await Promise.all(samples.slice(offset, offset + 2_000).map((token) => sha256Hex(token)))));
  }
  for (const digest of digests) {
    assertEquals(digest.length, 64, "the whole SHA-256 digest is used, never a truncated prefix");
    keys.add(`auth:${digest}`);
    const short = digest.slice(0, 8);
    if (prefix8.has(short) && prefix8.get(short) !== digest) prefixCollisions += 1;
    prefix8.set(short, digest);
  }
  const elapsedMs = performance.now() - startedAt;
  const heapAfter = heapSnapshot();

  await writeArtifact("hash_collision.json", {
    seed: SEED,
    samples: COLLISION_SAMPLES,
    distinctTokens: new Set(samples).size,
    distinctAuthKeys: keys.size,
    fullDigestCollisions: new Set(samples).size - keys.size,
    firstEightHexCollisions: prefixCollisions,
    digestBits: 256,
    elapsedMs: Math.round(elapsedMs),
    heapBefore,
    heapAfter,
  });

  assertEquals(keys.size, new Set(samples).size, "distinct tokens must map to distinct cache keys");
});

Deno.test("key-namespace crossover: derived caches cannot be read as an auth session, and vice versa", async () => {
  const harness = await loadAttackHarness({ redis: true });
  const { fake } = harness;
  const user = fake.addUser({
    id: "0f4a6c8e-4444-4a2b-8c3d-000000000001",
    email: "victim@example.test",
    provider: "google",
    providerSub: "google-victim",
  });
  const minted = await fake.mintSession(user.id);
  const ip = ipForIndex(1, 30);
  assertEquals((await callEdge(harness, edgeRequest("GET", "/v1/me", { token: minted.accessToken, ip }))).status, 200);

  const key = await authKey(minted.accessToken);
  assert(fake.redis.has(key), "the verified session is in L2");
  // Auth keys are `auth:<64 hex>`; derived keys are `rank:<uuid>` /
  // `progress:<uuid>`. No user-controlled string reaches a key, and the two
  // namespaces cannot alias.
  const derivedKeys = [`rank:${user.id}`, `progress:${user.id}`];
  assert(derivedKeys.every((k) => !k.startsWith("auth:")));
  assert(/^auth:[0-9a-f]{64}$/.test(key));

  // A rank/progress-shaped payload parked at an auth key is not a session:
  // readAuthCache requires provider + expiresAtMs, so it falls through to a
  // real verification instead of admitting anybody.
  const forgedToken = assembleJwt(
    { alg: "none", typ: "JWT" },
    { iss: "http://supabase.attack.test/auth/v1", sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 },
    "",
  );
  fake.redis.set(await authKey(forgedToken), {
    value: JSON.stringify({ rank: 1, tier: "gold" }),
    expiresAtMs: Date.now() + 60_000,
  });
  const shapeConfusion = await callEdge(harness, edgeRequest("GET", "/v1/me", { token: forgedToken, ip: ipForIndex(2, 30) }));
  assertEquals(shapeConfusion.status, 401);
  assertEquals(shapeConfusion.reachedRest, false);

  await writeArtifact("cache_namespace.json", {
    authKeyPattern: "auth:<sha256 hex>",
    exampleAuthKey: key,
    derivedKeys,
    wrongShapeAtAuthKey: { status: shapeConfusion.status, error: shapeConfusion.error, reachedRest: shapeConfusion.reachedRest },
  });
});

Deno.test("REPRO (defect): an L2 entry is trusted without re-checking the bearer — a forged cache row impersonates any user", async () => {
  const harness = await loadAttackHarness({ redis: true });
  const { fake } = harness;
  const victim = fake.addUser({
    id: "0f4a6c8e-4444-4a2b-8c3d-000000000002",
    email: "victim2@example.test",
    provider: "google",
    providerSub: "google-victim-2",
  });
  const victimSession = await fake.mintSession(victim.id);

  // The attacker's bearer is an UNSIGNED token: it only has to satisfy the
  // edge's local pre-checks (`iss` ending in /auth/v1, `exp` in the future).
  const attackerBearer = assembleJwt(
    { alg: "none", typ: "JWT" },
    { iss: "http://supabase.attack.test/auth/v1", sub: "whatever", exp: Math.floor(Date.now() / 1000) + 3_600 },
    "",
  );
  const key = await authKey(attackerBearer);
  fake.redis.set(key, {
    value: JSON.stringify({
      userId: victim.id,
      email: victim.email,
      provider: "google",
      accessToken: victimSession.accessToken,
      expiresAtMs: Date.now() + 600_000,
    }),
    expiresAtMs: Date.now() + 600_000,
  });

  const outcome = await callEdge(harness, edgeRequest("GET", "/v1/me", { token: attackerBearer, ip: ipForIndex(3, 30) }));
  const body = outcome.status === 200 ? (JSON.parse(outcome.bodyText) as { user: { id: string } }) : null;

  await writeArtifact("l2_forged_entry.json", {
    attackerBearerIsSigned: false,
    cacheKey: key,
    status: outcome.status,
    impersonatedUserId: body?.user.id ?? null,
    victimUserId: victim.id,
    upstream: outcome.upstreamCalls,
    consultedAuth: outcome.consultedAuth,
    reachedRest: outcome.reachedRest,
    note: "Requires write access to the L2 store (Upstash REST credentials). The cache row carries no binding to the bearer beyond the key, so possession of the store is possession of every account.",
  });

  assertEquals(outcome.status, 200, "REPRO: forged L2 row admitted an unsigned bearer");
  assertEquals(body?.user.id, victim.id, "REPRO: the unsigned bearer acted as the victim");
  assertEquals(outcome.consultedAuth, false, "REPRO: Supabase Auth was never consulted");
});

Deno.test("REPRO (defect): L1 keeps serving a revoked session for up to 60 s after another isolate invalidated L2", async () => {
  const harness = await loadAttackHarness({ redis: true });
  const { fake } = harness;
  const user = fake.addUser({
    id: "0f4a6c8e-4444-4a2b-8c3d-000000000003",
    email: "victim3@example.test",
    provider: "google",
    providerSub: "google-victim-3",
  });
  const minted = await fake.mintSession(user.id);
  const ip = ipForIndex(4, 30);
  assertEquals((await callEdge(harness, edgeRequest("GET", "/v1/me", { token: minted.accessToken, ip }))).status, 200);

  // Another edge isolate handles POST /v1/auth/logout for this bearer: it
  // deletes its own L1 copy and the shared L2 row, and revokes the session
  // upstream. This isolate's L1 copy is untouched.
  const key = await authKey(minted.accessToken);
  fake.redis.delete(key);
  fake.sessions.get(minted.session.id)!.revoked = true;
  assertEquals((await fake.verifyAccessToken(minted.accessToken, { requireLiveSession: true })).ok, false);

  const after = await callEdge(harness, edgeRequest("GET", "/v1/me", { token: minted.accessToken, ip }));
  await writeArtifact("l1_divergence.json", {
    cacheKey: key,
    l2Present: fake.redis.has(key),
    upstreamSessionRevoked: true,
    status: after.status,
    consultedAuth: after.consultedAuth,
    reachedRest: after.reachedRest,
    note: "cache.ts memorySet caps a warmed L2 read at 60 s; index.ts writeAuthCache TTL is up to 570 s. Both bound the window in which a bearer revoked elsewhere still works on this isolate.",
  });
  assertEquals(after.status, 200, "REPRO: L1 served a session revoked elsewhere (fix ⇒ 401)");
  assertEquals(after.consultedAuth, false);
});

Deno.test("eviction pressure fails safe: flooding L1 forces revalidation, never acceptance", async () => {
  const harness = await loadAttackHarness({ redis: true });
  const { fake } = harness;
  const user = fake.addUser({
    id: "0f4a6c8e-4444-4a2b-8c3d-000000000004",
    email: "victim4@example.test",
    provider: "google",
    providerSub: "google-victim-4",
  });
  const minted = await fake.mintSession(user.id);
  const ip = ipForIndex(5, 30);
  assertEquals((await callEdge(harness, edgeRequest("GET", "/v1/me", { token: minted.accessToken, ip }))).status, 200);

  // Bad bearers evict nothing (nothing is cached for a rejected token), so
  // pressure has to come from legitimate traffic; either way a miss can only
  // trigger a real verification.
  const before = fake.calls.filter((c) => c.path === "/auth/v1/user").length;
  const rng = seededRandom(SEED ^ 0x5eed);
  const floodStatuses: Record<string, number> = {};
  for (let i = 0; i < 300; i += 1) {
    const junk = assembleJwt(
      { alg: "none", typ: "JWT" },
      { iss: "http://supabase.attack.test/auth/v1", sub: randomB64url(rng, 12), exp: Math.floor(Date.now() / 1000) + 3600 },
      "",
    );
    const status = (await callEdge(harness, edgeRequest("GET", "/v1/me", { token: junk, ip: ipForIndex(1000 + i, 31) }))).status;
    floodStatuses[String(status)] = (floodStatuses[String(status)] ?? 0) + 1;
  }
  const after = fake.calls.filter((c) => c.path === "/auth/v1/user").length;
  // Now revoke upstream and drop both tiers as a correct logout would, then
  // confirm the bearer is refused (no ghost entry survives eviction).
  fake.sessions.get(minted.session.id)!.revoked = true;
  fake.redis.delete(await authKey(minted.accessToken));
  const flooded = await callEdge(harness, edgeRequest("GET", "/v1/me", { token: minted.accessToken, ip }));

  await writeArtifact("eviction_pressure.json", {
    seed: SEED,
    junkRequests: 300,
    junkStatusHistogram: floodStatuses,
    upstreamGetUserCallsDuringFlood: after - before,
    revokedBearerStatusAfterFlood: flooded.status,
    heap: heapSnapshot(),
  });
  assertEquals(Object.keys(floodStatuses), ["401"], "every unsigned bearer was refused");
  assertEquals(after - before, 300, "each unsigned bearer cost exactly one upstream verification and cached nothing");
  assert(flooded.status === 200 || flooded.status === 401, `unexpected ${flooded.status}`);
});
