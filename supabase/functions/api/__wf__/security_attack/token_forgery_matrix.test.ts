// Attack #1 — forged, unsigned and mis-issued bearers.
//
// Every request below is one an attacker can send with NO valid credential:
// alg:none, alg confusion, signature stripped/garbled/copied, wrong signing
// key ("another Supabase project"), issuer spoofing (`https://evil.test/auth/v1`
// satisfies the edge's local `iss.endsWith("/auth/v1")` pre-check), audience
// mismatch, expired, not-yet-valid, missing exp, wrong subject, header/payload
// swaps, and a seeded single-character fuzz of a legitimately signed token.
//
// The pass condition is absolute: 401 (or 4xx) AND the request must never
// reach the data plane (`/rest/v1/…`). One accepted request here is an auth
// bypass.
//
// Scale: the fixed matrix plus AUTH_ATTACK_FUZZ (default 600) seeded
// mutations, per route, against the real handler. Seed: AUTH_ATTACK_SEED.

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
import { FAKE_SUPABASE_URL, type Provider } from "./fakeSupabase.ts";
import {
  assembleJwt,
  b64urlDecodeBytes,
  b64urlEncode,
  decodeSegment,
  mutateSegment,
  randomB64url,
  seededRandom,
  signHs256,
  splitJwt,
} from "./jwt.ts";

const SEED = seedFromEnv();
const FUZZ_COUNT = Number(Deno.env.get("AUTH_ATTACK_FUZZ") ?? 600);
/** Routes an authenticated attacker would target: read, write, and the
 * account-destroying one. */
const TARGET_ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: "GET", path: "/v1/me" },
  { method: "GET", path: "/v1/me/access" },
  { method: "POST", path: "/v1/me/delete-request", body: {} },
];

interface AttemptRecord {
  index: number;
  attack: string;
  route: string;
  seed: number;
  ip: string;
  tokenSha256Prefix: string;
  header: unknown;
  payload: unknown;
  status: number;
  errorMessage: string | null;
  upstream: Array<{ method: string; path: string; bearer: string; status: number }>;
  reachedRest: boolean;
  accepted: boolean;
  /** True when every segment decodes to the SAME bytes as the legitimate
   * token (base64url trailing-bit aliasing): a different string, but the
   * identical credential — acceptance is correct, and it is recorded. */
  byteAliasOfLegit: boolean;
  /** For fuzz cases: exactly which character changed relative to the
   * legitimate token, so a run is replayable from the seed alone. */
  mutation?: { segment: string; position: number; from: string; to: string } | null;
}

function describeMutation(token: string, legit: string): AttemptRecord["mutation"] {
  const a = splitJwt(token);
  const b = splitJwt(legit);
  if (!a || !b) return null;
  for (const segment of ["header", "payload", "signature"] as const) {
    if (a[segment] === b[segment]) continue;
    for (let i = 0; i < a[segment].length; i += 1) {
      if (a[segment][i] !== b[segment][i]) return { segment, position: i, from: b[segment][i], to: a[segment][i] };
    }
  }
  return null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function isByteAlias(token: string, legit: string): boolean {
  if (token === legit) return true;
  const a = splitJwt(token);
  const b = splitJwt(legit);
  if (!a || !b) return false;
  try {
    return (
      sameBytes(b64urlDecodeBytes(a.header), b64urlDecodeBytes(b.header)) &&
      sameBytes(b64urlDecodeBytes(a.payload), b64urlDecodeBytes(b.payload)) &&
      sameBytes(b64urlDecodeBytes(a.signature), b64urlDecodeBytes(b.signature))
    );
  } catch {
    return false;
  }
}

async function tokenPrefix(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("forged / unsigned / mis-issued bearers are never accepted", async () => {
  const harness = await loadAttackHarness();
  const { fake } = harness;

  // A real, fully legitimate user + session: the baseline the forgeries are
  // derived from (so a forgery differs from an accepted token by exactly the
  // property under test).
  const victim = fake.addUser({
    id: "0f4a6c8e-1111-4a2b-8c3d-000000000001",
    email: "victim@example.test",
    provider: "google",
    providerSub: "google-victim-sub",
  });
  const legit = await fake.mintSession(victim.id);
  const legitParts = splitJwt(legit.accessToken)!;
  const legitHeader = decodeSegment(legitParts.header)!;
  const legitPayload = decodeSegment(legitParts.payload)!;
  const legitProviderToken = await fake.providerIdToken("google", victim.providerSub);
  const providerParts = splitJwt(legitProviderToken)!;
  const providerPayload = decodeSegment(providerParts.payload)!;

  const now = Math.floor(Date.now() / 1000);

  const cases: Array<{ attack: string; token: string }> = [];
  const push = (attack: string, token: string) => cases.push({ attack, token });

  // ── alg:none family (both bearer kinds the edge routes on) ────────────────
  push("alg-none.supabase-access-token", assembleJwt({ alg: "none", typ: "JWT" }, legitPayload, ""));
  push(
    "alg-none.supabase-access-token.signature-kept",
    assembleJwt({ alg: "none", typ: "JWT" }, legitPayload, legitParts.signature),
  );
  push("alg-none.uppercase-None", assembleJwt({ alg: "None", typ: "JWT" }, legitPayload, ""));
  push("alg-none.provider-id-token", assembleJwt({ alg: "none", typ: "JWT" }, providerPayload, ""));
  push(
    "alg-none.forged-admin-claims",
    assembleJwt(
      { alg: "none", typ: "JWT" },
      { ...legitPayload, role: "service_role", app_metadata: { provider: "google", providers: ["google"] } },
      "",
    ),
  );

  // ── signature tampering on an otherwise valid access token ────────────────
  push("signature.stripped", `${legitParts.header}.${legitParts.payload}.`);
  push("signature.garbage", `${legitParts.header}.${legitParts.payload}.${randomB64url(seededRandom(SEED), 43)}`);
  push(
    "signature.borrowed-from-provider-token",
    `${legitParts.header}.${legitParts.payload}.${providerParts.signature}`,
  );
  push("signature.truncated", `${legitParts.header}.${legitParts.payload}.${legitParts.signature.slice(0, 20)}`);

  // ── wrong key: "signed by another project" ────────────────────────────────
  push(
    "wrong-key.foreign-project-hs256",
    await signHs256(legitHeader, legitPayload, fake.foreignJwtSecret),
  );
  push(
    "wrong-key.attacker-rsa-google-token",
    await fake.providerIdToken("google", victim.providerSub, { signer: fake.rogueSigner }),
  );
  push(
    "wrong-key.attacker-rsa-apple-token",
    await fake.providerIdToken("apple", "apple-victim-sub", { signer: fake.rogueSigner }),
  );

  // ── alg confusion: RS256-shaped header over the HS256 secret and back ─────
  push(
    "alg-confusion.rs256-header-hs256-signature",
    await signHs256({ alg: "RS256", typ: "JWT", kid: "google-kid-1" }, legitPayload, fake.jwtSecret),
  );
  push(
    "alg-confusion.hs256-header-over-provider-claims",
    await signHs256({ alg: "HS256", typ: "JWT" }, providerPayload, fake.jwtSecret),
  );
  push(
    "alg-confusion.provider-claims-signed-with-project-secret",
    await signHs256({ alg: "HS256", typ: "JWT" }, { ...providerPayload, exp: now + 3600 }, fake.jwtSecret),
  );

  // ── issuer spoofing: satisfies the edge's local `endsWith("/auth/v1")` ────
  for (const iss of [
    "https://evil.test/auth/v1",
    "https://accounts.google.com.evil.test/auth/v1",
    `${FAKE_SUPABASE_URL}/auth/v1/../auth/v1`,
    "/auth/v1",
  ]) {
    push(
      `issuer-spoof.${iss}`,
      await signHs256(legitHeader, { ...legitPayload, iss }, fake.foreignJwtSecret),
    );
    push(`issuer-spoof-unsigned.${iss}`, assembleJwt({ alg: "none", typ: "JWT" }, { ...legitPayload, iss }, ""));
  }
  for (const iss of ["https://accounts.google.com", "https://appleid.apple.com"]) {
    push(
      `provider-issuer-spoof-unsigned.${iss}`,
      assembleJwt({ alg: "RS256", typ: "JWT" }, { ...providerPayload, iss }, "sig"),
    );
  }

  // ── audience / subject / expiry manipulation of provider tokens ───────────
  for (const provider of ["google", "apple"] as Provider[]) {
    push(
      `provider.${provider}.audience-mismatch`,
      await fake.providerIdToken(provider, "attacker-sub", { claims: { aud: "some.other.client" } }),
    );
    push(
      `provider.${provider}.expired`,
      await fake.providerIdToken(provider, victim.providerSub, { claims: { exp: now - 5, iat: now - 3605 } }),
    );
    push(
      `provider.${provider}.exp-as-string`,
      await fake.providerIdToken(provider, victim.providerSub, { claims: { exp: String(now - 5) } }),
    );
    push(
      `provider.${provider}.no-exp`,
      await fake.providerIdToken(provider, victim.providerSub, { claims: { exp: undefined } }),
    );
    push(
      `provider.${provider}.unknown-kid`,
      await fake.providerIdToken(provider, victim.providerSub, { header: { kid: "attacker-kid" } }),
    );
  }

  // ── access-token claim manipulation (signed with the wrong key, since the
  // attacker cannot sign with the project secret) ───────────────────────────
  push(
    "claims.foreign-signed-other-subject",
    await signHs256(legitHeader, { ...legitPayload, sub: "22222222-2222-4222-8222-222222222222" }, fake.foreignJwtSecret),
  );
  push(
    "claims.foreign-signed-service-role",
    await signHs256(legitHeader, { ...legitPayload, role: "service_role" }, fake.foreignJwtSecret),
  );
  push(
    "claims.foreign-signed-no-session-id",
    await signHs256(legitHeader, { ...legitPayload, session_id: undefined }, fake.foreignJwtSecret),
  );
  push(
    "claims.foreign-signed-far-future-exp",
    await signHs256(legitHeader, { ...legitPayload, exp: now + 10 * 365 * 86_400 }, fake.foreignJwtSecret),
  );
  push(
    "claims.expired-but-correctly-signed",
    await signHs256(legitHeader, { ...legitPayload, exp: now - 1 }, fake.jwtSecret),
  );
  push(
    "claims.exp-boundary-now",
    await signHs256(legitHeader, { ...legitPayload, exp: now }, fake.jwtSecret),
  );
  push(
    "claims.nonexistent-user-correctly-signed",
    await signHs256(legitHeader, { ...legitPayload, sub: "99999999-9999-4999-8999-999999999999" }, fake.jwtSecret),
  );
  push(
    "claims.unknown-session-correctly-signed",
    await signHs256(legitHeader, { ...legitPayload, session_id: crypto.randomUUID() }, fake.jwtSecret),
  );

  // ── structural abuse ─────────────────────────────────────────────────────
  push("structure.empty", "");
  push("structure.dots-only", "..");
  push("structure.two-segments", `${legitParts.header}.${legitParts.payload}`);
  push("structure.four-segments", `${legitParts.header}.${legitParts.payload}.${legitParts.signature}.extra`);
  push("structure.payload-is-array", assembleJwt({ alg: "none" }, [] as unknown as Record<string, unknown>, ""));
  push("structure.payload-not-json", `${b64urlEncode(JSON.stringify({ alg: "none" }))}.bm90LWpzb24.`);
  push("structure.header-payload-swapped", `${legitParts.payload}.${legitParts.header}.${legitParts.signature}`);
  push("structure.provider-token-with-tab", `${legitProviderToken}\tx`);
  push("structure.access-token-doubled", `${legit.accessToken}${legit.accessToken}`);
  push("structure.access-token-comma-joined", `${legit.accessToken}, Bearer ${legit.accessToken}`);

  // ── seeded single-character fuzz of a legitimately signed access token ────
  const rng = seededRandom(SEED);
  for (let i = 0; i < FUZZ_COUNT; i += 1) {
    const which = i % 3;
    const header = which === 0 ? mutateSegment(rng, legitParts.header) : legitParts.header;
    const payload = which === 1 ? mutateSegment(rng, legitParts.payload) : legitParts.payload;
    const signature = which === 2 ? mutateSegment(rng, legitParts.signature) : legitParts.signature;
    push(`fuzz.mutate-${["header", "payload", "signature"][which]}.${i}`, `${header}.${payload}.${signature}`);
  }

  // ── Execute every case against every target route ─────────────────────────
  const attempts: AttemptRecord[] = [];
  const accepted: AttemptRecord[] = [];
  const aliases: AttemptRecord[] = [];
  let index = 0;
  for (const attack of cases) {
    for (const route of TARGET_ROUTES) {
      const ip = ipForIndex(index);
      const parts = splitJwt(attack.token);
      const outcome = await callEdge(
        harness,
        edgeRequest(route.method, route.path, {
          token: attack.token,
          ip,
          body: route.body,
        }),
      );
      const record: AttemptRecord = {
        index,
        attack: attack.attack,
        route: `${route.method} ${route.path}`,
        seed: SEED,
        ip,
        tokenSha256Prefix: await tokenPrefix(attack.token),
        header: parts ? decodeSegment(parts.header) : null,
        payload: parts ? decodeSegment(parts.payload) : null,
        status: outcome.status,
        errorMessage: outcome.error,
        upstream: outcome.upstreamCalls,
        reachedRest: outcome.reachedRest,
        accepted: outcome.status < 400 || outcome.reachedRest,
        byteAliasOfLegit: isByteAlias(attack.token, legit.accessToken),
        mutation: attack.attack.startsWith("fuzz.") ? describeMutation(attack.token, legit.accessToken) : undefined,
      };
      attempts.push(record);
      if (record.byteAliasOfLegit) aliases.push(record);
      else if (record.accepted) accepted.push(record);
      index += 1;
    }
  }

  const statusHistogram: Record<string, number> = {};
  for (const attempt of attempts) {
    statusHistogram[String(attempt.status)] = (statusHistogram[String(attempt.status)] ?? 0) + 1;
  }

  await writeArtifact("forgery_matrix.json", {
    seed: SEED,
    legitTokenShape: {
      header: legitHeader,
      payloadClaims: legitPayload,
      segmentLengths: [legitParts.header.length, legitParts.payload.length, legitParts.signature.length],
      sha256Prefix: await tokenPrefix(legit.accessToken),
    },
    fuzzCount: FUZZ_COUNT,
    caseCount: cases.length,
    routeCount: TARGET_ROUTES.length,
    attemptCount: attempts.length,
    statusHistogram,
    acceptedCount: accepted.length,
    accepted,
    byteAliasCount: aliases.length,
    byteAliases: aliases,
    heap: heapSnapshot(),
    attempts,
  });

  assertEquals(
    accepted.map((record) => `${record.attack} @ ${record.route} → ${record.status}`),
    [],
    "forged/unsigned/mis-issued bearer was accepted",
  );
  // Every attempt must be a client rejection, never a 5xx (a crash on a
  // malformed bearer would itself be a finding).
  const nonClientErrors = attempts.filter(
    (attempt) => !attempt.byteAliasOfLegit && (attempt.status < 400 || attempt.status >= 500),
  );
  assertEquals(nonClientErrors.map((a) => `${a.attack} → ${a.status}`), []);
  assert(attempts.length >= (cases.length) * TARGET_ROUTES.length);
});

Deno.test("base64url alias of a legitimate bearer is the same credential: accepted, but cached and evicted under a DIFFERENT key", async () => {
  const harness = await loadAttackHarness();
  const { fake } = harness;
  const user = fake.addUser({
    id: "0f4a6c8e-1111-4a2b-8c3d-000000000009",
    email: "alias@example.test",
    provider: "google",
    providerSub: "google-alias-sub",
  });
  const legit = (await fake.mintSession(user.id)).accessToken;
  const parts = splitJwt(legit)!;
  // A 43-char base64url signature (32 bytes) carries 2 padding bits in its
  // last char: the four alphabet characters sharing the top 4 bits decode to
  // identical bytes.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  assertEquals(parts.signature.length, 43);
  const last = parts.signature.slice(-1);
  const lastIndex = alphabet.indexOf(last);
  const aliasChar = alphabet[(lastIndex & ~3) | ((lastIndex + 1) & 3)];
  const alias = `${parts.header}.${parts.payload}.${parts.signature.slice(0, -1)}${aliasChar}`;
  assert(alias !== legit && isByteAlias(alias, legit));

  const ip = ipForIndex(1, 12);
  const viaLegit = await callEdge(harness, edgeRequest("GET", "/v1/me", { token: legit, ip }));
  const viaAlias = await callEdge(harness, edgeRequest("GET", "/v1/me", { token: alias, ip }));
  assertEquals(viaLegit.status, 200);
  assertEquals(viaAlias.status, 200, "the alias decodes to the same signature bytes and verifies upstream");
  assertEquals(viaAlias.consultedAuth, true, "…but it is a cache MISS: keyed by string hash, not by credential");

  // Logout with the canonical string evicts only the canonical key.
  const logout = await callEdge(harness, edgeRequest("POST", "/v1/auth/logout", { token: legit, ip }));
  assertEquals(logout.status, 204);
  const legitAfter = await callEdge(harness, edgeRequest("GET", "/v1/me", { token: legit, ip }));
  const aliasAfter = await callEdge(harness, edgeRequest("GET", "/v1/me", { token: alias, ip }));
  await writeArtifact("signature_alias.json", {
    legitSha256Prefix: await tokenPrefix(legit),
    aliasSha256Prefix: await tokenPrefix(alias),
    lastSignatureChar: { legit: last, alias: aliasChar },
    viaAlias: { status: viaAlias.status, consultedAuth: viaAlias.consultedAuth },
    afterLogout: { legit: legitAfter.status, alias: aliasAfter.status, aliasConsultedAuth: aliasAfter.consultedAuth },
  });
  assertEquals(legitAfter.status, 401);
  // Same defect class as the sibling-bearer REPRO: a byte-identical
  // credential under another cache key survives logout.
  assertEquals(aliasAfter.status, 200, "REPRO: alias of the logged-out bearer still served from cache");
  assertEquals(aliasAfter.consultedAuth, false);
});

Deno.test("bootstrap refuses every forged provider ID token", async () => {
  const harness = await loadAttackHarness();
  const { fake } = harness;
  const now = Math.floor(Date.now() / 1000);
  const usersBefore = fake.users.size;
  const sessionsBefore = fake.sessions.size;

  const attacks: Array<{ attack: string; token: string }> = [
    {
      attack: "bootstrap.alg-none",
      token: assembleJwt(
        { alg: "none", typ: "JWT" },
        { iss: "https://accounts.google.com", sub: "attacker", aud: "attack-harness-google-client", exp: now + 3600 },
        "",
      ),
    },
    {
      attack: "bootstrap.unsigned-rs256-header",
      token: assembleJwt(
        { alg: "RS256", typ: "JWT", kid: "google-kid-1" },
        { iss: "https://accounts.google.com", sub: "attacker", aud: "attack-harness-google-client", exp: now + 3600 },
        "sig",
      ),
    },
    {
      attack: "bootstrap.attacker-rsa-key",
      token: await fake.providerIdToken("google", "attacker", { signer: fake.rogueSigner }),
    },
    {
      attack: "bootstrap.audience-mismatch",
      token: await fake.providerIdToken("apple", "attacker", { claims: { aud: "com.attacker.app" } }),
    },
    {
      attack: "bootstrap.expired",
      token: await fake.providerIdToken("google", "attacker", { claims: { exp: now - 1 } }),
    },
    {
      attack: "bootstrap.supabase-access-token-as-id-token",
      token: (await fake.mintSession(
        fake.addUser({
          id: "0f4a6c8e-2222-4a2b-8c3d-000000000002",
          email: "other@example.test",
          provider: "google",
          providerSub: "google-other-sub",
        }).id,
      )).accessToken,
    },
    {
      attack: "bootstrap.no-subject",
      token: await fake.providerIdToken("google", "", { claims: { sub: undefined } }),
    },
  ];

  const results = [];
  let index = 5000;
  for (const attack of attacks) {
    const outcome = await callEdge(
      harness,
      edgeRequest("POST", "/v1/account/bootstrap", {
        token: attack.token,
        ip: ipForIndex(index),
        body: {},
      }),
    );
    results.push({
      attack: attack.attack,
      status: outcome.status,
      error: outcome.error,
      upstream: outcome.upstreamCalls,
      reachedRest: outcome.reachedRest,
    });
    index += 1;
  }

  await writeArtifact("bootstrap_forgery.json", {
    seed: SEED,
    usersBefore,
    usersAfter: fake.users.size,
    sessionsBefore,
    sessionsAfter: fake.sessions.size,
    results,
  });

  assertEquals(
    results.filter((r) => r.status !== 401).map((r) => `${r.attack} → ${r.status}`),
    [],
    "bootstrap accepted a forged provider ID token",
  );
  assertEquals(results.filter((r) => r.reachedRest).map((r) => r.attack), []);
  // No forged bootstrap may create an account or mint a session.
  assertEquals(fake.users.size, usersBefore + 1, "only the fixture user was added");
  assertEquals(fake.sessions.size, sessionsBefore + 1, "only the fixture session was minted");
});
