// W04-03 ADVERSARIAL — attacks the candidate (d257a6af) WITHSTANDS.
//
// Every test here is an attack at a failure boundary of the key-ring rotation
// contract that the candidate's own tests do not exercise: kid/material
// confusion, a zero-length overlap, the exact 7-day bound, the retirement-iat
// second, hostile JWK material and window values, verifier clock rollback,
// concurrent issuance through the REAL edge handler while the secret rotates,
// cache behaviour across valid → malformed → valid → different-valid secrets,
// a rotation whose overlap already ended, and the two-keys-at-most guardrail.
//
// Passing here means the candidate held. The module is loaded dynamically so
// the file fails with assertions (not a module-load error) on BASE_SHA, where
// no key ring exists — this doubles as an independent AC3 regress file.
//
// Confirmed breaks live in w04_03_attack_rotation_breaks.test.ts.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { exportJWK, generateKeyPair } from "jose";
import {
  OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
  OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
  OFFLINE_GRANT_AUDIENCE,
  OFFLINE_PRO_LEASE_MAX_SECONDS,
  OFFLINE_PRO_LEASE_SCHEMA_VERSION,
  type OfflineExecutionGrantClaims,
  type OfflineReleasedArtifacts,
} from "../../../../packages/shared-types/src/offlineAuthorization.ts";
import {
  OfflineGrantCryptoError,
  signOfflineExecutionGrant,
  type OfflineGrantKey,
  type OfflineGrantVerificationContext,
} from "../offlineSignature.ts";
import { activeReleasePolicyRow, HARNESS_RELEASE_POLICY } from "./releasePolicyFixture.ts";
import { fakeGoogleIdToken, loadHarness, SUPABASE_URL, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

const GRANTS_PATH = "/v1/offline/grants";
const GRANT_RPC = "/rest/v1/rpc/issue_offline_grant";
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const K1 = "w04-03-atk-key-1";
const K2 = "w04-03-atk-key-2";
const K3 = "w04-03-atk-key-3";
const INSTALLATION_KEY = "ios-installation-w04-03-attack";
const GRANT_ID = "44444444-0403-4444-8444-444444444444";
const DAY = 86_400;
const NOW = 1_788_000_000;

interface Pair {
  kid: string;
  privateJwk: Record<string, unknown>;
  publicJwk: Record<string, unknown>;
  signer: OfflineGrantKey;
}

async function pair(kid: string): Promise<Pair> {
  const generated = await generateKeyPair("ES256", { extractable: true });
  return {
    kid,
    privateJwk: { ...(await exportJWK(generated.privateKey)), kid },
    publicJwk: { ...(await exportJWK(generated.publicKey)), kid },
    signer: { purpose: "offline_execution_grant", kid, key: generated.privateKey },
  };
}

const k1 = await pair(K1);
const k2 = await pair(K2);
const k3 = await pair(K3);

const releasePolicyRow = await activeReleasePolicyRow();
const approval = releasePolicyRow.approval as { policy: { version: string; sha256: string } };
const RELEASE: OfflineReleasedArtifacts = {
  policy: approval.policy,
  mechanicsModel: HARNESS_RELEASE_POLICY.mechanics.lineage.model,
  benchmarkModel: HARNESS_RELEASE_POLICY.benchmark.lineage.model,
};
const TEST_RELEASE: OfflineReleasedArtifacts = {
  policy: { version: "w04-03-attack-policy", sha256: "a".repeat(64) },
  mechanicsModel: { version: "w04-03-attack-mechanics", sha256: "b".repeat(64) },
  benchmarkModel: { version: "w04-03-attack-benchmark", sha256: "c".repeat(64) },
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();

interface KeyRing {
  readonly signingKey: OfflineGrantKey;
  readonly activeKey: OfflineGrantKey;
  readonly previousKey:
    | (OfflineGrantKey & {
        readonly retiredAtEpochSeconds: number;
        readonly overlapEndsAtEpochSeconds: number;
      })
    | null;
  readonly allowedKeyIds: readonly string[];
}

interface RotationModule {
  OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS: number;
  importOfflineGrantKeyRing: (configured: unknown) => Promise<KeyRing>;
  verifyOfflineExecutionGrant: (
    raw: unknown,
    keys: KeyRing | readonly OfflineGrantKey[],
    expected: OfflineGrantVerificationContext,
  ) => Promise<{ claims: OfflineExecutionGrantClaims; protectedHeader: { kid: string } }>;
}

async function loadRotation(): Promise<RotationModule> {
  const module: Record<string, unknown> = await import("../offlineSignature.ts");
  assert(
    typeof module.importOfflineGrantKeyRing === "function" &&
      typeof module.OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS === "number",
    "offlineSignature.ts must export importOfflineGrantKeyRing and the rotation bound",
  );
  return module as unknown as RotationModule;
}

function ring(
  active: Pair,
  previous: { key: Pair; retiredAt: number; overlapEndsAt: number } | null,
  previousJwkOverride?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    active: active.privateJwk,
    previous:
      previous === null
        ? null
        : {
            jwk: previousJwkOverride ?? previous.key.publicJwk,
            retiredAtEpochSeconds: previous.retiredAt,
            overlapEndsAtEpochSeconds: previous.overlapEndsAt,
          },
  };
}

function moduleContext(
  allowedKeyIds: readonly string[],
  nowEpochSeconds: number,
): OfflineGrantVerificationContext {
  return {
    binding: {
      issuer: "https://w04-03-attack.invalid/grants",
      allowedKeyIds,
      ownerId: "12345678-1234-4234-8234-123456789abc",
      installationKeyId: INSTALLATION_KEY,
    },
    release: structuredClone(TEST_RELEASE),
    nowEpochSeconds,
  };
}

function moduleClaims(
  iat: number,
  leaseSeconds = OFFLINE_PRO_LEASE_MAX_SECONDS,
): OfflineExecutionGrantClaims {
  const expected = moduleContext([K1], iat);
  return {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: expected.binding.issuer,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: expected.binding.ownerId,
    jti: "w04-03-attack-grant",
    installationKeyId: INSTALLATION_KEY,
    iat,
    exp: iat + leaseSeconds,
    capabilities: ["analyze_joint_output"],
    release: structuredClone(TEST_RELEASE),
    entitlementSource: "verified_store",
    lease: {
      schemaVersion: OFFLINE_PRO_LEASE_SCHEMA_VERSION,
      kind: "lifetime",
      verifiedEntitlementExpiresAt: null,
    },
  };
}

async function rejectWith(
  code: OfflineGrantCryptoError["code"] | "retired_key",
  run: () => Promise<unknown>,
  message?: string,
): Promise<void> {
  const error = await assertRejects(run, OfflineGrantCryptoError, undefined, message);
  assertEquals((error as { code: string }).code, code, message);
}

/** Signs with `material` but stamps `kid` in the protected header — the shape
 * of a key-confusion attack the canonical signer refuses to produce. */
async function signWithMismatchedKid(
  claims: OfflineExecutionGrantClaims,
  material: Pair,
  kid: string,
  allowedKeyIds: readonly string[],
): Promise<unknown> {
  return await signOfflineExecutionGrant(
    claims,
    { ...material.signer, kid },
    moduleContext(allowedKeyIds, claims.iat),
  );
}

// ---------------------------------------------------------------------------
// Module contract attacks
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK kid confusion: a grant tagged with the previous kid but signed by the active material (and vice versa) is invalid_signature, never retired_key or valid",
  async () => {
    const rotation = await loadRotation();
    const retiredAt = NOW + DAY;
    const configured = await rotation.importOfflineGrantKeyRing(
      ring(k2, { key: k1, retiredAt, overlapEndsAt: retiredAt + 2 * DAY }),
    );
    const allowed = configured.allowedKeyIds;

    // Attacker holds the (compromised) old private key K1 and stamps the ACTIVE kid.
    const oldMaterialNewKid = await signWithMismatchedKid(moduleClaims(NOW), k1, K2, allowed);
    for (const now of [NOW, retiredAt + DAY, retiredAt + 3 * DAY]) {
      await rejectWith(
        "invalid_signature",
        () =>
          rotation.verifyOfflineExecutionGrant(
            oldMaterialNewKid,
            configured,
            moduleContext(allowed, now),
          ),
        `K1 material under K2 kid at ${now}`,
      );
    }
    // Active material under the previous kid inside the overlap: still not the previous key.
    const newMaterialOldKid = await signWithMismatchedKid(moduleClaims(NOW), k2, K1, allowed);
    await rejectWith("invalid_signature", () =>
      rotation.verifyOfflineExecutionGrant(
        newMaterialOldKid,
        configured,
        moduleContext(allowed, NOW + 1),
      ),
    );
    // A third key the ring never held is invalid_key even when the binding allowlists it.
    const foreign = await signWithMismatchedKid(moduleClaims(NOW), k3, K3, [K2, K1, K3]);
    await rejectWith("invalid_key", () =>
      rotation.verifyOfflineExecutionGrant(
        foreign,
        configured,
        moduleContext([K2, K1, K3], NOW + 1),
      ),
    );
  },
);

Deno.test(
  "ATTACK zero-length overlap: retiredAt == overlapEndsAt imports, previous-key grants are retired_key from that exact second and valid one second earlier",
  async () => {
    const rotation = await loadRotation();
    const instant = NOW + DAY;
    const configured = await rotation.importOfflineGrantKeyRing(
      ring(k2, { key: k1, retiredAt: instant, overlapEndsAt: instant }),
    );
    const underK1 = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      k1.signer,
      moduleContext(configured.allowedKeyIds, NOW),
    );
    const before = await rotation.verifyOfflineExecutionGrant(
      underK1,
      configured,
      moduleContext(configured.allowedKeyIds, instant - 1),
    );
    assertEquals(before.protectedHeader.kid, K1);
    for (const now of [instant, instant + 1, instant + 5 * DAY]) {
      await rejectWith(
        "retired_key",
        () =>
          rotation.verifyOfflineExecutionGrant(
            underK1,
            configured,
            moduleContext(configured.allowedKeyIds, now),
          ),
        String(now),
      );
    }
    // The active key is untouched at every one of those instants.
    const underK2 = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      k2.signer,
      moduleContext(configured.allowedKeyIds, NOW),
    );
    for (const now of [instant - 1, instant, instant + 5 * DAY]) {
      const verified = await rotation.verifyOfflineExecutionGrant(
        underK2,
        configured,
        moduleContext(configured.allowedKeyIds, now),
      );
      assertEquals(verified.protectedHeader.kid, K2);
    }
  },
);

Deno.test(
  "ATTACK maximum overlap: exactly OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS imports and honours its last second; one second longer is invalid_key; an expired previous-key grant is invalid_time before retired_key",
  async () => {
    const rotation = await loadRotation();
    const max = rotation.OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS;
    assertEquals(max, OFFLINE_PRO_LEASE_MAX_SECONDS);
    const retiredAt = NOW;
    await rejectWith(
      "invalid_key",
      () =>
        rotation.importOfflineGrantKeyRing(
          ring(k2, { key: k1, retiredAt, overlapEndsAt: retiredAt + max + 1 }),
        ),
      "max + 1",
    );
    const configured = await rotation.importOfflineGrantKeyRing(
      ring(k2, { key: k1, retiredAt, overlapEndsAt: retiredAt + max }),
    );
    // A full-length Pro lease minted in the retirement second …
    const lastMinted = await signOfflineExecutionGrant(
      moduleClaims(retiredAt),
      k1.signer,
      moduleContext(configured.allowedKeyIds, retiredAt),
    );
    // … is valid at the last second of the overlap (its own exp == overlapEndsAt),
    const verified = await rotation.verifyOfflineExecutionGrant(
      lastMinted,
      configured,
      moduleContext(configured.allowedKeyIds, retiredAt + max - 1),
    );
    assertEquals(verified.claims.exp, retiredAt + max);
    // … and at overlapEndsAt it is expired AND retired: the time check wins (no retired_key leak of a dead grant).
    await rejectWith("invalid_time", () =>
      rotation.verifyOfflineExecutionGrant(
        lastMinted,
        configured,
        moduleContext(configured.allowedKeyIds, retiredAt + max),
      ),
    );
    // A short-lease grant that outlives nothing: inside the window and unexpired → valid.
    const shortLease = await signOfflineExecutionGrant(
      moduleClaims(retiredAt - DAY, DAY),
      k1.signer,
      moduleContext(configured.allowedKeyIds, retiredAt - DAY),
    );
    const short = await rotation.verifyOfflineExecutionGrant(
      shortLease,
      configured,
      moduleContext(configured.allowedKeyIds, retiredAt - 1),
    );
    assertEquals(short.protectedHeader.kid, K1);
  },
);

Deno.test(
  "ATTACK retirement second: iat == retiredAt is honoured, iat == retiredAt + 1 under the previous key is retired_key everywhere inside the overlap, and a verifier clock behind iat fails closed with invalid_time",
  async () => {
    const rotation = await loadRotation();
    const retiredAt = NOW + DAY;
    const overlapEndsAt = retiredAt + 3 * DAY;
    const configured = await rotation.importOfflineGrantKeyRing(
      ring(k2, { key: k1, retiredAt, overlapEndsAt }),
    );
    const allowed = configured.allowedKeyIds;

    const atRetirement = await signOfflineExecutionGrant(
      moduleClaims(retiredAt),
      k1.signer,
      moduleContext(allowed, retiredAt),
    );
    const verified = await rotation.verifyOfflineExecutionGrant(
      atRetirement,
      configured,
      moduleContext(allowed, retiredAt + DAY),
    );
    assertEquals(verified.claims.iat, retiredAt);

    const afterRetirement = await signOfflineExecutionGrant(
      moduleClaims(retiredAt + 1),
      k1.signer,
      moduleContext(allowed, retiredAt + 1),
    );
    for (const now of [retiredAt + 1, retiredAt + DAY, overlapEndsAt - 1]) {
      await rejectWith(
        "retired_key",
        () =>
          rotation.verifyOfflineExecutionGrant(
            afterRetirement,
            configured,
            moduleContext(allowed, now),
          ),
        String(now),
      );
    }
    // Clock rollback below the grant's own iat: invalid_time, not a valid or retired verdict.
    await rejectWith("invalid_time", () =>
      rotation.verifyOfflineExecutionGrant(
        afterRetirement,
        configured,
        moduleContext(allowed, retiredAt),
      ),
    );
    await rejectWith("invalid_time", () =>
      rotation.verifyOfflineExecutionGrant(
        atRetirement,
        configured,
        moduleContext(allowed, retiredAt - 1),
      ),
    );
    // The same late-minted claims under the ACTIVE key are fine: the rule is per key.
    const activeLate = await signOfflineExecutionGrant(
      moduleClaims(retiredAt + 1),
      k2.signer,
      moduleContext(allowed, retiredAt + 1),
    );
    const ok = await rotation.verifyOfflineExecutionGrant(
      activeLate,
      configured,
      moduleContext(allowed, overlapEndsAt + DAY),
    );
    assertEquals(ok.protectedHeader.kid, K2);
  },
);

Deno.test(
  "ATTACK hostile ring values: wrong key type / curve / usage, numeric-string / fractional / negative / -0 / unsafe / NaN / Infinity window values, an inverted window and malformed kids are all invalid_key",
  async () => {
    const rotation = await loadRotation();
    const window = { retiredAt: NOW, overlapEndsAt: NOW + DAY };
    const hostile: Array<[string, unknown]> = [
      [
        "previous with the active key's kid on foreign material",
        ring(k2, { key: k1, ...window }, { ...k1.publicJwk, kid: K2 }),
      ],
      [
        "previous as an RSA-looking JWK",
        ring(k2, { key: k1, ...window }, { kty: "RSA", n: "AQAB", e: "AQAB", kid: K1 }),
      ],
      [
        "previous as an OKP JWK",
        ring(k2, { key: k1, ...window }, { kty: "OKP", crv: "Ed25519", x: "AAAA", kid: K1 }),
      ],
      ["previous on P-384", ring(k2, { key: k1, ...window }, { ...k1.publicJwk, crv: "P-384" })],
      [
        "previous jwk without kty",
        ring(
          k2,
          { key: k1, ...window },
          { crv: "P-256", x: k1.publicJwk.x, y: k1.publicJwk.y, kid: K1 },
        ),
      ],
      [
        "previous jwk with key_ops sign",
        ring(k2, { key: k1, ...window }, { ...k1.publicJwk, key_ops: ["sign"] }),
      ],
      [
        "previous jwk with use enc",
        ring(k2, { key: k1, ...window }, { ...k1.publicJwk, use: "enc" }),
      ],
      [
        "previous jwk with alg ES384",
        ring(k2, { key: k1, ...window }, { ...k1.publicJwk, alg: "ES384" }),
      ],
      [
        "numeric-string retiredAt",
        {
          ...ring(k2, null),
          previous: {
            jwk: k1.publicJwk,
            retiredAtEpochSeconds: String(NOW),
            overlapEndsAtEpochSeconds: NOW + DAY,
          },
        },
      ],
      ["fractional overlapEndsAt", ring(k2, { key: k1, retiredAt: NOW, overlapEndsAt: NOW + 0.5 })],
      ["negative retiredAt", ring(k2, { key: k1, retiredAt: -1, overlapEndsAt: DAY })],
      ["-0 retiredAt", ring(k2, { key: k1, retiredAt: -0, overlapEndsAt: DAY })],
      [
        "unsafe overlapEndsAt",
        ring(k2, {
          key: k1,
          retiredAt: Number.MAX_SAFE_INTEGER,
          overlapEndsAt: Number.MAX_SAFE_INTEGER + 1,
        }),
      ],
      ["NaN retiredAt", ring(k2, { key: k1, retiredAt: Number.NaN, overlapEndsAt: NOW })],
      [
        "Infinity overlapEndsAt",
        ring(k2, { key: k1, retiredAt: NOW, overlapEndsAt: Number.POSITIVE_INFINITY }),
      ],
      ["inverted window", ring(k2, { key: k1, retiredAt: NOW + 1, overlapEndsAt: NOW })],
      [
        "null window members",
        {
          ...ring(k2, null),
          previous: {
            jwk: k1.publicJwk,
            retiredAtEpochSeconds: null,
            overlapEndsAtEpochSeconds: null,
          },
        },
      ],
      ["previous as an array", { ...ring(k2, null), previous: [] }],
      ["previous as a string", { ...ring(k2, null), previous: JSON.stringify(k1.publicJwk) }],
      [
        "active with a 129-char kid",
        { ...ring(k2, null), active: { ...k2.privateJwk, kid: "k".repeat(129) } },
      ],
      ["active with an empty kid", { ...ring(k2, null), active: { ...k2.privateJwk, kid: "" } }],
      [
        "active with a kid containing whitespace",
        { ...ring(k2, null), active: { ...k2.privateJwk, kid: "key one" } },
      ],
      ["legacy bare JWK carrying a previous member", { ...k2.privateJwk, previous: null }],
      ["legacy bare JWK carrying a schemaVersion", { ...k2.privateJwk, schemaVersion: 1 }],
    ];
    for (const [name, document] of hostile) {
      await rejectWith("invalid_key", () => rotation.importOfflineGrantKeyRing(document), name);
    }
    // Sanity: the same window with sane material still imports.
    const sane = await rotation.importOfflineGrantKeyRing(ring(k2, { key: k1, ...window }));
    assertEquals(sane.allowedKeyIds, [K2, K1]);
    assert(
      Object.isFrozen(sane) &&
        Object.isFrozen(sane.allowedKeyIds) &&
        Object.isFrozen(sane.previousKey),
    );
    assertEquals(sane.signingKey.key.extractable, false);
  },
);

Deno.test(
  "ATTACK verifier clock: a previous-key grant refused at overlapEndsAt is re-admitted only if the trusted clock is rolled back below it — the window follows nowEpochSeconds, never the token",
  async () => {
    const rotation = await loadRotation();
    const retiredAt = NOW + DAY;
    const overlapEndsAt = retiredAt + DAY;
    const configured = await rotation.importOfflineGrantKeyRing(
      ring(k2, { key: k1, retiredAt, overlapEndsAt }),
    );
    const allowed = configured.allowedKeyIds;
    const underK1 = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      k1.signer,
      moduleContext(allowed, NOW),
    );

    await rejectWith("retired_key", () =>
      rotation.verifyOfflineExecutionGrant(
        underK1,
        configured,
        moduleContext(allowed, overlapEndsAt),
      ),
    );
    const rolledBack = await rotation.verifyOfflineExecutionGrant(
      underK1,
      configured,
      moduleContext(allowed, overlapEndsAt - 1),
    );
    assertEquals(rolledBack.protectedHeader.kid, K1);
    // Hostile `now` values fail closed before any key is consulted.
    for (const now of [
      Number.NaN,
      0.5,
      -0,
      -1,
      Number.MAX_SAFE_INTEGER + 1,
      Number.POSITIVE_INFINITY,
    ]) {
      await rejectWith(
        "invalid_time",
        () =>
          rotation.verifyOfflineExecutionGrant(underK1, configured, moduleContext(allowed, now)),
        String(now),
      );
    }
  },
);

Deno.test(
  "ATTACK two keys at most: rotating K1→K2→K3 while K1 is still inside its overlap makes K1 grants invalid_key immediately (documented guardrail) while K2 grants follow the new window",
  async () => {
    const rotation = await loadRotation();
    const firstRotation = NOW;
    const second = await rotation.importOfflineGrantKeyRing(
      ring(k3, { key: k2, retiredAt: firstRotation + DAY, overlapEndsAt: firstRotation + 3 * DAY }),
    );
    assertEquals(second.allowedKeyIds, [K3, K2]);
    const underK1 = await signOfflineExecutionGrant(
      moduleClaims(NOW - DAY),
      k1.signer,
      moduleContext([K1], NOW - DAY),
    );
    const underK2 = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      k2.signer,
      moduleContext([K2, K1], NOW),
    );
    // K1 is gone from the ring even though its old window (NOW .. NOW+7d) would still be open.
    await rejectWith("invalid_key", () =>
      rotation.verifyOfflineExecutionGrant(
        underK1,
        second,
        moduleContext([K3, K2, K1], firstRotation + 1),
      ),
    );
    const inside = await rotation.verifyOfflineExecutionGrant(
      underK2,
      second,
      moduleContext(second.allowedKeyIds, firstRotation + 3 * DAY - 1),
    );
    assertEquals(inside.protectedHeader.kid, K2);
    await rejectWith("retired_key", () =>
      rotation.verifyOfflineExecutionGrant(
        underK2,
        second,
        moduleContext(second.allowedKeyIds, firstRotation + 3 * DAY),
      ),
    );
  },
);

// ---------------------------------------------------------------------------
// Real edge handler attacks
// ---------------------------------------------------------------------------

interface GrantRow {
  result: string;
  grant_id: string | null;
  generation: number | null;
  entitlement_source: string | null;
  issued_at: string | null;
  expires_at: string | null;
  entitlement_expires_at: string | null;
  ticket_ids: string[] | null;
}

function proRow(issuedAt: number, leaseSeconds: number): GrantRow {
  return {
    result: "accepted",
    grant_id: GRANT_ID,
    generation: 1,
    entitlement_source: "verified_store",
    issued_at: iso(issuedAt),
    expires_at: iso(issuedAt + leaseSeconds),
    entitlement_expires_at: iso(issuedAt + 30 * DAY),
    ticket_ids: [],
  };
}

let userSeq = 0;
function freshUser(): { sub: string; token: string } {
  userSeq += 1;
  const sub = `bbbbbbbb-0403-4000-8000-${String(userSeq).padStart(12, "0")}`;
  return { sub, token: fakeGoogleIdToken(sub) };
}

function reset(secret: unknown): void {
  h.reset();
  Deno.env.set(SIGNING_ENV, typeof secret === "string" ? secret : JSON.stringify(secret));
  h.rpcs.issue_offline_grant = [proRow(nowSeconds() - 1, 3 * DAY)];
}

async function issue(token: string): Promise<Response> {
  return await h.handler(
    userRequest("POST", GRANTS_PATH, { token, body: { installationKeyId: INSTALLATION_KEY } }),
  );
}

function routeContext(
  ownerId: string,
  allowedKeyIds: readonly string[],
  nowEpochSeconds = nowSeconds(),
): OfflineGrantVerificationContext {
  return {
    binding: { issuer: ISSUER, allowedKeyIds, ownerId, installationKeyId: INSTALLATION_KEY },
    release: RELEASE,
    nowEpochSeconds,
  };
}

Deno.test(
  "ATTACK concurrent issuance across a rotation: three simultaneous requests under the ring all sign with the ACTIVE key and each spends exactly one grant",
  async () => {
    const rotation = await loadRotation();
    const users = [freshUser(), freshUser(), freshUser()];
    const document = ring(k2, {
      key: k1,
      retiredAt: nowSeconds() - 1,
      overlapEndsAt: nowSeconds() + DAY,
    });
    reset(document);
    const responses = await Promise.all(users.map((user) => issue(user.token)));
    const configured = await rotation.importOfflineGrantKeyRing(document);
    for (const [index, response] of responses.entries()) {
      assertEquals(response.status, 200, `request ${index}`);
      const body = (await response.json()) as { keyId: string; grant: unknown };
      assertEquals(body.keyId, K2);
      const verified = await rotation.verifyOfflineExecutionGrant(
        body.grant,
        configured,
        routeContext(users[index].sub, configured.allowedKeyIds),
      );
      assertEquals(verified.protectedHeader.kid, K2);
      // Never verifiable by the previous key alone, even with the full allowlist.
      await rejectWith("invalid_key", () =>
        rotation.verifyOfflineExecutionGrant(
          body.grant,
          [configured.previousKey as OfflineGrantKey],
          routeContext(users[index].sub, [K2, K1]),
        ),
      );
    }
    assertEquals(h.callsTo(GRANT_RPC).length, users.length);
  },
);

Deno.test(
  "ATTACK secret churn: valid → malformed → same valid → different valid; the cache never serves a stale or half-configured ring and every 503 spends nothing",
  async () => {
    const rotation = await loadRotation();
    const user = freshUser();
    const now = nowSeconds();
    const ringA = ring(k2, { key: k1, retiredAt: now - 1, overlapEndsAt: now + DAY });
    const ringB = ring(k3, { key: k2, retiredAt: now, overlapEndsAt: now + DAY });

    reset(ringA);
    let response = await issue(user.token);
    assertEquals(response.status, 200);
    assertEquals(((await response.json()) as { keyId: string }).keyId, K2);
    assertEquals(h.callsTo(GRANT_RPC).length, 1);

    // Malformed variants of the SAME ring (one byte of damage each): 503, no RPC, nothing signed.
    const damaged: unknown[] = [
      {
        ...ringA,
        previous: {
          ...(ringA.previous as Record<string, unknown>),
          overlapEndsAtEpochSeconds: now + 8 * DAY,
        },
      },
      { ...ringA, active: { ...(ringA.active as Record<string, unknown>), d: undefined } },
      `${JSON.stringify(ringA)}x`,
      " ",
      JSON.stringify(ringA).replace(`"schemaVersion":1`, `"schemaVersion":1.0000001`),
    ];
    for (const document of damaged) {
      reset(document);
      response = await issue(user.token);
      assertEquals(
        response.status,
        503,
        typeof document === "string" ? document.slice(0, 40) : "object",
      );
      const text = await response.text();
      assert(!text.includes(K1) && !text.includes(K2) && !text.includes('"d"'));
      assertEquals(h.callsTo(GRANT_RPC).length, 0);
    }

    // Back to ring A: served (possibly from cache) with the SAME active key.
    reset(ringA);
    response = await issue(user.token);
    assertEquals(response.status, 200);
    assertEquals(((await response.json()) as { keyId: string }).keyId, K2);

    // A different valid ring: the active key follows the new secret immediately.
    reset(ringB);
    response = await issue(user.token);
    assertEquals(response.status, 200);
    const body = (await response.json()) as { keyId: string; grant: unknown };
    assertEquals(body.keyId, K3);
    const configuredB = await rotation.importOfflineGrantKeyRing(ringB);
    const verified = await rotation.verifyOfflineExecutionGrant(
      body.grant,
      configuredB,
      routeContext(user.sub, configuredB.allowedKeyIds),
    );
    assertEquals(verified.protectedHeader.kid, K3);
    // Ring A (which never held K3) cannot verify it.
    const configuredA = await rotation.importOfflineGrantKeyRing(ringA);
    await rejectWith("invalid_key", () =>
      rotation.verifyOfflineExecutionGrant(
        body.grant,
        configuredA,
        routeContext(user.sub, [K2, K1, K3]),
      ),
    );
  },
);

Deno.test(
  "ATTACK late rotation: a ring whose overlap already ended still issues under the active key; the pre-rotation grant is retired_key at once and invalid_key after the previous entry is dropped",
  async () => {
    const rotation = await loadRotation();
    const user = freshUser();
    reset(k1.privateJwk);
    const before = await issue(user.token);
    assertEquals(before.status, 200);
    const outstanding = (await before.json()) as { keyId: string; grant: unknown };
    assertEquals(outstanding.keyId, K1);

    const now = nowSeconds();
    const stale = ring(k2, { key: k1, retiredAt: now - 2 * DAY, overlapEndsAt: now - DAY });
    reset(stale);
    const after = await issue(user.token);
    assertEquals(after.status, 200);
    assertEquals(((await after.json()) as { keyId: string }).keyId, K2);

    const configured = await rotation.importOfflineGrantKeyRing(stale);
    await rejectWith("retired_key", () =>
      rotation.verifyOfflineExecutionGrant(
        outstanding.grant,
        configured,
        routeContext(user.sub, configured.allowedKeyIds, now),
      ),
    );
    const dropped = await rotation.importOfflineGrantKeyRing(ring(k2, null));
    await rejectWith("invalid_key", () =>
      rotation.verifyOfflineExecutionGrant(
        outstanding.grant,
        dropped,
        routeContext(user.sub, [K2, K1], now),
      ),
    );
    // Legacy bare-JWK rollback to K1 honours the outstanding grant again (documented roll-back path).
    const rolledBack = await rotation.importOfflineGrantKeyRing(k1.privateJwk);
    const verified = await rotation.verifyOfflineExecutionGrant(
      outstanding.grant,
      rolledBack,
      routeContext(user.sub, rolledBack.allowedKeyIds, now),
    );
    assertEquals(verified.protectedHeader.kid, K1);
  },
);
