// W04-03 — offline signing-key rotation with a bounded overlap window.
//
// The edge fn signs offline execution grants with ONE active ES256 key and
// tags every signature with that key's `kid`. Rotation replaces the secret
// `OFFLINE_GRANT_SIGNING_JWK` with a key-ring document: the new ACTIVE private
// key plus the PREVIOUS key's PUBLIC half and an explicit overlap window
// (`retiredAtEpochSeconds` ≤ `overlapEndsAtEpochSeconds`, at most
// OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS long). Receipts/grants signed under
// the previous key verify ONLY while `now < overlapEndsAtEpochSeconds`; at and
// after that instant they are rejected as `retired_key` even though the
// signature is still mathematically valid. A key the ring does not know is
// `invalid_key` regardless of the window.
//
// Two halves, both black-box:
//   * the module contract through a dynamic import of ../offlineSignature.ts
//     (so this file loads on BASE_SHA, where the key ring does not exist and
//     every test here fails);
//   * the REAL edge handler through routesHarness: a key-ring secret signs with
//     the active key, a grant issued before rotation still verifies with the
//     rotated ring inside the overlap and not after it, and a malformed ring
//     (private previous key, unbounded overlap, colliding kids, unknown
//     schema) is refused with a generic 503 before any grant is spent.
//
// Key-material consistency: the ring is only usable if every key in it is
// what it claims to be. An active private JWK whose public coordinates do
// not belong to its private scalar `d` would sign grants that the ring's own
// public half rejects; a previous public JWK that is not a P-256 point, or
// that repeats the active key's material under another kid, is a rotation
// that verifies nothing or does not rotate. All of these are `invalid_key`
// at import, so the route answers 503 and spends nothing.
//
// Anchoring the window to real time (round 3):
//   * every instant in the ring is a Unix-seconds value no later than
//     OFFLINE_KEY_ROTATION_MAX_EPOCH_SECONDS (the shared offline contract's
//     bound) — a millisecond slip or a near-MAX_SAFE_INTEGER instant is
//     `invalid_key` at import instead of a window that never closes;
//   * the previous key is honoured only while its `retiredAtEpochSeconds` is
//     no more than OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS ahead of the
//     verifier's trusted `now` — a retirement instant the ring merely claims
//     lies years ahead cannot keep the old key an accepted issuer;
//   * the old key may legitimately still have signed for up to that same
//     grace after `retiredAtEpochSeconds` (the secret propagates lazily), so
//     `iat ≤ retiredAt + grace` verifies and `iat > retiredAt + grace` is
//     `retired_key`;
//   * a previous point that is the NEGATION of the active point (same `x`,
//     `y' = p − y`) is controlled by the active private scalar (`n − d`) and
//     is refused like the identical point.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { base64url, exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";
import {
  OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
  OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
  OFFLINE_GRANT_AUDIENCE,
  OFFLINE_GRANT_JWS_TYPE,
  OFFLINE_PRO_LEASE_MAX_SECONDS,
  OFFLINE_PRO_LEASE_SCHEMA_VERSION,
  OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
  type OfflineExecutionGrantClaims,
  type OfflineReleasedArtifacts,
} from "../../../../packages/shared-types/src/offlineAuthorization.ts";
import {
  importOfflineGrantVerificationKey,
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
const PREVIOUS_KID = "w04-03-key-2026-08";
const ACTIVE_KID = "w04-03-key-2026-09";
const UNKNOWN_KID = "w04-03-key-never-configured";
const INSTALLATION_KEY = "ios-installation-w04-03";
const GRANT_ID = "44444444-0403-4444-8444-444444444444";
const DAY = 86_400;
const NOW = 1_788_000_000;

const previousPair = await generateKeyPair("ES256", { extractable: true });
const activePair = await generateKeyPair("ES256", { extractable: true });
const unknownPair = await generateKeyPair("ES256", { extractable: true });
const previousPrivateJwk = { ...(await exportJWK(previousPair.privateKey)), kid: PREVIOUS_KID };
const previousPublicJwk = { ...(await exportJWK(previousPair.publicKey)), kid: PREVIOUS_KID };
const activePrivateJwk = { ...(await exportJWK(activePair.privateKey)), kid: ACTIVE_KID };
const activePublicJwk = { ...(await exportJWK(activePair.publicKey)), kid: ACTIVE_KID };
const unknownPublicJwk = await exportJWK(unknownPair.publicKey);
/** Private scalar of the active key, public coordinates of another key. */
const mismatchedActiveJwk = { ...activePrivateJwk, x: unknownPublicJwk.x, y: unknownPublicJwk.y };
/** base64url of 32 zero bytes: (0, 0) is not on P-256. */
const ZERO_COORDINATE = "A".repeat(43);

const previousSigningKey: OfflineGrantKey = {
  purpose: "offline_execution_grant",
  kid: PREVIOUS_KID,
  key: previousPair.privateKey,
};
const activeSigningKey: OfflineGrantKey = {
  purpose: "offline_execution_grant",
  kid: ACTIVE_KID,
  key: activePair.privateKey,
};
const unknownSigningKey: OfflineGrantKey = {
  purpose: "offline_execution_grant",
  kid: UNKNOWN_KID,
  key: unknownPair.privateKey,
};
const activePublicKey = await importOfflineGrantVerificationKey(ACTIVE_KID, activePublicJwk);

// P-256 field prime and group order (big-endian), for the negated-point case.
const P256_P = BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

function coordinateToBigInt(coordinate: string): bigint {
  let hex = "";
  for (const byte of base64url.decode(coordinate)) hex += byte.toString(16).padStart(2, "0");
  return BigInt(`0x${hex}`);
}

function bigIntToCoordinate(value: bigint): string {
  const hex = value.toString(16).padStart(64, "0");
  return base64url.encode(Uint8Array.from(hex.match(/.{2}/g)!.map((b) => Number.parseInt(b, 16))));
}

/** `−P` for the active public point: same `x`, `y' = p − y`. Its private scalar is `n − d`. */
const negatedActivePublicJwk = {
  kty: "EC",
  crv: "P-256",
  kid: PREVIOUS_KID,
  x: activePublicJwk.x,
  y: bigIntToCoordinate(P256_P - coordinateToBigInt(activePublicJwk.y!)),
};
const negatedActivePrivateKey = (await importJWK(
  {
    ...negatedActivePublicJwk,
    d: bigIntToCoordinate(P256_N - coordinateToBigInt(activePrivateJwk.d!)),
  },
  "ES256",
  { extractable: false },
)) as CryptoKey;

const releasePolicyRow = await activeReleasePolicyRow();
const approval = releasePolicyRow.approval as { policy: { version: string; sha256: string } };
const RELEASE: OfflineReleasedArtifacts = {
  policy: approval.policy,
  mechanicsModel: HARNESS_RELEASE_POLICY.mechanics.lineage.model,
  benchmarkModel: HARNESS_RELEASE_POLICY.benchmark.lineage.model,
};
const TEST_RELEASE: OfflineReleasedArtifacts = {
  policy: { version: "w04-03-policy", sha256: "a".repeat(64) },
  mechanicsModel: { version: "w04-03-mechanics", sha256: "b".repeat(64) },
  benchmarkModel: { version: "w04-03-benchmark", sha256: "c".repeat(64) },
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();

// ---------------------------------------------------------------------------
// The module contract under test, loaded dynamically so BASE_SHA fails here
// with an assertion instead of a module-load error.
// ---------------------------------------------------------------------------

interface RetiredKeyDocument {
  jwk: unknown;
  retiredAtEpochSeconds: unknown;
  overlapEndsAtEpochSeconds: unknown;
}

interface KeyRingDocument {
  schemaVersion: unknown;
  active: unknown;
  previous: RetiredKeyDocument | null;
}

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
  OFFLINE_GRANT_KEY_RING_SCHEMA_VERSION: number;
  OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS: number;
  OFFLINE_KEY_ROTATION_MAX_EPOCH_SECONDS: number;
  OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS: number;
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
      typeof module.OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS === "number" &&
      typeof module.OFFLINE_GRANT_KEY_RING_SCHEMA_VERSION === "number",
    "offlineSignature.ts must export importOfflineGrantKeyRing and the rotation bounds",
  );
  return module as unknown as RotationModule;
}

/** The round-3 time-anchoring bounds: both must be exported, finite, and
 * sized so a grace never reaches the overlap bound. */
async function loadAnchoredRotation(): Promise<RotationModule> {
  const rotation = await loadRotation();
  const module: Record<string, unknown> = rotation as unknown as Record<string, unknown>;
  assert(
    typeof module.OFFLINE_KEY_ROTATION_MAX_EPOCH_SECONDS === "number" &&
      typeof module.OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS === "number",
    "offlineSignature.ts must export OFFLINE_KEY_ROTATION_MAX_EPOCH_SECONDS and OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS",
  );
  const grace = rotation.OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS;
  assert(Number.isSafeInteger(grace) && grace > 0 && grace <= 3600, String(grace));
  assert(grace < rotation.OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS);
  // 9999-12-31T23:59:59Z — the same bound the shared offline contract applies to iat/exp.
  assertEquals(rotation.OFFLINE_KEY_ROTATION_MAX_EPOCH_SECONDS, 253_402_300_799);
  return rotation;
}

/** Signs `claims` under an arbitrary private key and kid, bypassing the
 * module's own signer (which insists on the configured key object). */
async function signAs(
  claims: OfflineExecutionGrantClaims,
  key: CryptoKey,
  kid: string,
): Promise<{ schemaVersion: string; compactJws: string }> {
  const compactJws = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "ES256", typ: OFFLINE_GRANT_JWS_TYPE, kid })
    .sign(key);
  return { schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION, compactJws };
}

function ringDocument(options: {
  retiredAt?: number;
  overlapEndsAt?: number;
  previous?: RetiredKeyDocument | null;
  active?: unknown;
  schemaVersion?: unknown;
}): KeyRingDocument {
  const retiredAt = options.retiredAt ?? NOW;
  return {
    schemaVersion: options.schemaVersion ?? 1,
    active: options.active ?? activePrivateJwk,
    previous:
      options.previous === undefined
        ? {
            jwk: previousPublicJwk,
            retiredAtEpochSeconds: retiredAt,
            overlapEndsAtEpochSeconds: options.overlapEndsAt ?? retiredAt + 7 * DAY,
          }
        : options.previous,
  };
}

function moduleContext(
  allowedKeyIds: readonly string[],
  nowEpochSeconds: number,
): OfflineGrantVerificationContext {
  return {
    binding: {
      issuer: "https://offline-key-rotation-test.invalid/grants",
      allowedKeyIds,
      ownerId: "12345678-1234-4234-8234-123456789abc",
      installationKeyId: INSTALLATION_KEY,
    },
    release: structuredClone(TEST_RELEASE),
    nowEpochSeconds,
  };
}

function moduleClaims(iat: number): OfflineExecutionGrantClaims {
  const expected = moduleContext([PREVIOUS_KID], iat);
  return {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: expected.binding.issuer,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: expected.binding.ownerId,
    jti: "w04-03-grant",
    installationKeyId: INSTALLATION_KEY,
    iat,
    exp: iat + OFFLINE_PRO_LEASE_MAX_SECONDS,
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

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

Deno.test(
  "receipt signed under the retired key verifies inside the overlap and is rejected at/after overlapEndsAt (retired_key)",
  async () => {
    const rotation = await loadAnchoredRotation();
    const grace = rotation.OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS;
    const retiredAt = NOW + DAY;
    const overlapEndsAt = retiredAt + 2 * DAY;
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt, overlapEndsAt }),
    );
    assertEquals(ring.allowedKeyIds, [ACTIVE_KID, PREVIOUS_KID]);
    assertEquals(ring.signingKey.kid, ACTIVE_KID);
    assertEquals(ring.previousKey?.overlapEndsAtEpochSeconds, overlapEndsAt);

    // Issued under the previous key BEFORE the rotation (a real outstanding grant).
    const issuedAt = NOW;
    const underPrevious = await signOfflineExecutionGrant(
      moduleClaims(issuedAt),
      previousSigningKey,
      moduleContext(ring.allowedKeyIds, issuedAt),
    );
    const underActive = await signOfflineExecutionGrant(
      moduleClaims(issuedAt),
      activeSigningKey,
      moduleContext(ring.allowedKeyIds, issuedAt),
    );

    // Inside the overlap (as early as the grace lets the ring be in force,
    // just before and at retirement, last second): accepted.
    for (const now of [retiredAt - grace, retiredAt - 1, retiredAt, overlapEndsAt - 1]) {
      const verified = await rotation.verifyOfflineExecutionGrant(
        underPrevious,
        ring,
        moduleContext(ring.allowedKeyIds, now),
      );
      assertEquals(verified.protectedHeader.kid, PREVIOUS_KID, String(now));
      assertEquals(verified.claims.jti, "w04-03-grant");
    }

    // At and after the exclusive end: the same, still-unexpired receipt is refused.
    for (const now of [overlapEndsAt, overlapEndsAt + 1, overlapEndsAt + DAY]) {
      assert(now < moduleClaims(issuedAt).exp, "the grant itself must still be unexpired");
      await rejectWith(
        "retired_key",
        () =>
          rotation.verifyOfflineExecutionGrant(
            underPrevious,
            ring,
            moduleContext(ring.allowedKeyIds, now),
          ),
        String(now),
      );
      // The active key is unaffected by the previous key's window.
      const verified = await rotation.verifyOfflineExecutionGrant(
        underActive,
        ring,
        moduleContext(ring.allowedKeyIds, now),
      );
      assertEquals(verified.protectedHeader.kid, ACTIVE_KID);
    }

    // The binding allowlist still applies on top of the ring (kid outside it is
    // refused by the shared metadata contract before any key is consulted).
    await rejectWith("invalid_metadata", () =>
      rotation.verifyOfflineExecutionGrant(
        underPrevious,
        ring,
        moduleContext([ACTIVE_KID], retiredAt),
      ),
    );

    // A key the ring never knew is invalid_key in every window.
    const underUnknown = await signOfflineExecutionGrant(
      moduleClaims(issuedAt),
      unknownSigningKey,
      moduleContext([UNKNOWN_KID], issuedAt),
    );
    for (const now of [issuedAt, retiredAt, overlapEndsAt]) {
      await rejectWith("invalid_key", () =>
        rotation.verifyOfflineExecutionGrant(
          underUnknown,
          ring,
          moduleContext([...ring.allowedKeyIds, UNKNOWN_KID], now),
        ),
      );
    }

    // Once the previous key is dropped from the ring, its receipts are invalid_key.
    const dropped = await rotation.importOfflineGrantKeyRing(ringDocument({ previous: null }));
    assertEquals(dropped.allowedKeyIds, [ACTIVE_KID]);
    assertEquals(dropped.previousKey, null);
    await rejectWith("invalid_key", () =>
      rotation.verifyOfflineExecutionGrant(
        underPrevious,
        dropped,
        moduleContext([ACTIVE_KID, PREVIOUS_KID], issuedAt),
      ),
    );
  },
);

Deno.test(
  "a legacy single private JWK is a ring with no previous key, and the ring exposes only public verification material",
  async () => {
    const rotation = await loadRotation();
    const ring = await rotation.importOfflineGrantKeyRing(activePrivateJwk);
    assertEquals(ring.allowedKeyIds, [ACTIVE_KID]);
    assertEquals(ring.previousKey, null);
    assertEquals(ring.signingKey.kid, ACTIVE_KID);
    assertEquals(ring.signingKey.key.type, "private");
    assertEquals(ring.activeKey.kid, ACTIVE_KID);
    assertEquals(ring.activeKey.key.type, "public");
    assertEquals(ring.activeKey.key.extractable, false);
    assertEquals(ring.signingKey.key.extractable, false);
    assert(Object.isFrozen(ring));

    const rotated = await rotation.importOfflineGrantKeyRing(ringDocument({}));
    assertEquals(rotated.previousKey?.kid, PREVIOUS_KID);
    assertEquals(rotated.previousKey?.key.type, "public");
    assertEquals(rotated.previousKey?.key.extractable, false);
    assertEquals(rotated.previousKey?.retiredAtEpochSeconds, NOW);
    assertEquals(rotated.previousKey?.overlapEndsAtEpochSeconds, NOW + 7 * DAY);

    // A grant signed with the ring's active key verifies through the ring.
    const signed = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      rotated.signingKey,
      moduleContext(rotated.allowedKeyIds, NOW),
    );
    const verified = await rotation.verifyOfflineExecutionGrant(
      signed,
      rotated,
      moduleContext(rotated.allowedKeyIds, NOW + 7 * DAY - 1),
    );
    assertEquals(verified.protectedHeader.kid, ACTIVE_KID);
  },
);

Deno.test(
  "key ring import enforces the bounded overlap and refuses private, colliding, unknown or malformed entries",
  async () => {
    const rotation = await loadRotation();
    const max = rotation.OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS;
    assert(Number.isSafeInteger(max) && max >= OFFLINE_PRO_LEASE_MAX_SECONDS);

    // Boundaries that are accepted: zero-length and exactly the maximum overlap.
    await rotation.importOfflineGrantKeyRing(ringDocument({ retiredAt: NOW, overlapEndsAt: NOW }));
    await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt: NOW, overlapEndsAt: NOW + max }),
    );

    const rejected: readonly (readonly [string, unknown])[] = [
      ["overlap one second past the bound", ringDocument({ overlapEndsAt: NOW + max + 1 })],
      ["overlap ending before retirement", ringDocument({ overlapEndsAt: NOW - 1 })],
      ["negative retirement", ringDocument({ retiredAt: -1, overlapEndsAt: DAY })],
      [
        "fractional instants",
        ringDocument({
          previous: {
            jwk: previousPublicJwk,
            retiredAtEpochSeconds: NOW + 0.5,
            overlapEndsAtEpochSeconds: NOW + DAY,
          },
        }),
      ],
      [
        "string instants",
        ringDocument({
          previous: {
            jwk: previousPublicJwk,
            retiredAtEpochSeconds: String(NOW),
            overlapEndsAtEpochSeconds: String(NOW + DAY),
          },
        }),
      ],
      [
        "previous key given as PRIVATE material",
        ringDocument({
          previous: {
            jwk: previousPrivateJwk,
            retiredAtEpochSeconds: NOW,
            overlapEndsAtEpochSeconds: NOW + DAY,
          },
        }),
      ],
      [
        "previous key without a kid",
        ringDocument({
          previous: {
            jwk: { ...previousPublicJwk, kid: undefined },
            retiredAtEpochSeconds: NOW,
            overlapEndsAtEpochSeconds: NOW + DAY,
          },
        }),
      ],
      [
        "previous kid equal to the active kid",
        ringDocument({
          previous: {
            jwk: { ...previousPublicJwk, kid: ACTIVE_KID },
            retiredAtEpochSeconds: NOW,
            overlapEndsAtEpochSeconds: NOW + DAY,
          },
        }),
      ],
      [
        "previous entry with an unknown member",
        {
          ...ringDocument({}),
          previous: {
            jwk: previousPublicJwk,
            retiredAtEpochSeconds: NOW,
            overlapEndsAtEpochSeconds: NOW + DAY,
            privateJwk: previousPrivateJwk,
          },
        },
      ],
      [
        "previous entry missing its window",
        { ...ringDocument({}), previous: { jwk: previousPublicJwk } },
      ],
      ["active given as PUBLIC material", ringDocument({ active: activePublicJwk })],
      ["active missing", { schemaVersion: 1, previous: null }],
      ["unknown schema version", ringDocument({ schemaVersion: 2 })],
      ["string schema version", ringDocument({ schemaVersion: "1" })],
      ["unknown top-level member", { ...ringDocument({}), previousPrivateJwk }],
      ["array", [activePrivateJwk]],
      ["null", null],
      ["string", JSON.stringify(activePrivateJwk)],
      ["bare public JWK", activePublicJwk],
    ];
    for (const [name, document] of rejected) {
      await rejectWith("invalid_key", () => rotation.importOfflineGrantKeyRing(document), name);
    }
  },
);

Deno.test(
  "key ring import refuses an active private JWK whose public coordinates do not belong to d (legacy and schema-1 forms)",
  async () => {
    const rotation = await loadRotation();
    // Sanity: the consistent key imports and round-trips through its own ring.
    const consistent = await rotation.importOfflineGrantKeyRing(activePrivateJwk);
    const signed = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      consistent.signingKey,
      moduleContext(consistent.allowedKeyIds, NOW),
    );
    await rotation.verifyOfflineExecutionGrant(
      signed,
      consistent,
      moduleContext(consistent.allowedKeyIds, NOW),
    );

    const rejected: readonly (readonly [string, unknown])[] = [
      ["legacy form, coordinates of another key", mismatchedActiveJwk],
      ["schema-1 form, coordinates of another key", ringDocument({ active: mismatchedActiveJwk })],
      [
        "schema-1 form with a previous key, coordinates of another key",
        ringDocument({ active: mismatchedActiveJwk, retiredAt: NOW }),
      ],
      ["legacy form, x of another key", { ...activePrivateJwk, x: unknownPublicJwk.x }],
      ["legacy form, y of another key", { ...activePrivateJwk, y: unknownPublicJwk.y }],
      [
        "legacy form, coordinates not on the curve",
        { ...activePrivateJwk, x: ZERO_COORDINATE, y: ZERO_COORDINATE },
      ],
      [
        "schema-1 form, coordinates not on the curve",
        ringDocument({ active: { ...activePrivateJwk, x: ZERO_COORDINATE, y: ZERO_COORDINATE } }),
      ],
    ];
    for (const [name, document] of rejected) {
      await rejectWith("invalid_key", () => rotation.importOfflineGrantKeyRing(document), name);
    }
  },
);

Deno.test(
  "key ring import refuses a previous public JWK that is not a P-256 point or that repeats the active key's material",
  async () => {
    const rotation = await loadRotation();
    const rejected: readonly (readonly [string, unknown])[] = [
      [
        "previous coordinates not on the curve",
        ringDocument({
          previous: {
            jwk: { ...previousPublicJwk, x: ZERO_COORDINATE, y: ZERO_COORDINATE },
            retiredAtEpochSeconds: NOW,
            overlapEndsAtEpochSeconds: NOW + DAY,
          },
        }),
      ],
      [
        "previous y of another key",
        ringDocument({
          previous: {
            jwk: { ...previousPublicJwk, y: unknownPublicJwk.y },
            retiredAtEpochSeconds: NOW,
            overlapEndsAtEpochSeconds: NOW + DAY,
          },
        }),
      ],
      [
        "previous entry is the active public half under another kid",
        ringDocument({
          previous: {
            jwk: { ...activePublicJwk, kid: PREVIOUS_KID },
            retiredAtEpochSeconds: NOW,
            overlapEndsAtEpochSeconds: NOW + DAY,
          },
        }),
      ],
    ];
    for (const [name, document] of rejected) {
      await rejectWith("invalid_key", () => rotation.importOfflineGrantKeyRing(document), name);
    }
  },
);

Deno.test(
  "a binding that allowlists only the active kid still verifies active-key grants through a ring with a previous key",
  async () => {
    const rotation = await loadRotation();
    const retiredAt = NOW + DAY;
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt, overlapEndsAt: retiredAt + 2 * DAY }),
    );
    const underActive = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      activeSigningKey,
      moduleContext(ring.allowedKeyIds, NOW),
    );
    const underPrevious = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      previousSigningKey,
      moduleContext(ring.allowedKeyIds, NOW),
    );
    const narrow = await rotation.verifyOfflineExecutionGrant(
      underActive,
      ring,
      moduleContext([ACTIVE_KID], NOW + 1),
    );
    assertEquals(narrow.protectedHeader.kid, ACTIVE_KID);
    // Narrowing never widens: the previous kid stays refused by the allowlist.
    await rejectWith("invalid_metadata", () =>
      rotation.verifyOfflineExecutionGrant(
        underPrevious,
        ring,
        moduleContext([ACTIVE_KID], NOW + 1),
      ),
    );
  },
);

Deno.test(
  "the previous key's window travels with the key object: handed to the verifier as a list entry it still refuses receipts after overlapEndsAt",
  async () => {
    const rotation = await loadRotation();
    const retiredAt = NOW + DAY;
    const overlapEndsAt = retiredAt + DAY;
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt, overlapEndsAt }),
    );
    const previousKey = ring.previousKey;
    assert(previousKey !== null);
    const underPrevious = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      previousSigningKey,
      moduleContext(ring.allowedKeyIds, NOW),
    );
    const list: readonly OfflineGrantKey[] = [ring.activeKey, previousKey];
    const inside = await rotation.verifyOfflineExecutionGrant(
      underPrevious,
      list,
      moduleContext(ring.allowedKeyIds, overlapEndsAt - 1),
    );
    assertEquals(inside.protectedHeader.kid, PREVIOUS_KID);
    for (const now of [overlapEndsAt, overlapEndsAt + DAY]) {
      await rejectWith(
        "retired_key",
        () =>
          rotation.verifyOfflineExecutionGrant(
            underPrevious,
            list,
            moduleContext(ring.allowedKeyIds, now),
          ),
        String(now),
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Round 3 — the window is anchored to real time and to the trusted clock
// ---------------------------------------------------------------------------

Deno.test(
  "key ring import refuses retirement instants outside the Unix-seconds contract: milliseconds, near MAX_SAFE_INTEGER, past 9999-12-31",
  async () => {
    const rotation = await loadAnchoredRotation();
    const max = rotation.OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS;
    const maxEpoch = rotation.OFFLINE_KEY_ROTATION_MAX_EPOCH_SECONDS;
    const retiredAtMs = NOW * 1000;
    const rejected: readonly (readonly [string, unknown])[] = [
      [
        "retiredAt in milliseconds, 7-day overlap",
        ringDocument({ retiredAt: retiredAtMs, overlapEndsAt: retiredAtMs + max }),
      ],
      [
        "retiredAt in seconds, overlapEndsAt in milliseconds",
        ringDocument({ retiredAt: NOW, overlapEndsAt: (NOW + DAY) * 1000 }),
      ],
      [
        "retiredAt at MAX_SAFE_INTEGER - max",
        ringDocument({
          retiredAt: Number.MAX_SAFE_INTEGER - max,
          overlapEndsAt: Number.MAX_SAFE_INTEGER,
        }),
      ],
      [
        "retiredAt one second past the contract bound",
        ringDocument({ retiredAt: maxEpoch + 1, overlapEndsAt: maxEpoch + 1 }),
      ],
      [
        "overlapEndsAt one second past the contract bound",
        ringDocument({ retiredAt: maxEpoch, overlapEndsAt: maxEpoch + 1 }),
      ],
    ];
    for (const [name, document] of rejected) {
      await rejectWith("invalid_key", () => rotation.importOfflineGrantKeyRing(document), name);
    }

    // Exactly the bound still imports (it is a Unix-seconds value) — and the
    // trusted-clock rule below keeps such a ring from honouring anything today.
    const farFuture = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt: maxEpoch - max, overlapEndsAt: maxEpoch }),
    );
    assertEquals(farFuture.previousKey?.overlapEndsAtEpochSeconds, maxEpoch);
    const underPrevious = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      previousSigningKey,
      moduleContext(farFuture.allowedKeyIds, NOW),
    );
    await rejectWith("retired_key", () =>
      rotation.verifyOfflineExecutionGrant(
        underPrevious,
        farFuture,
        moduleContext(farFuture.allowedKeyIds, NOW + 1),
      ),
    );
  },
);

Deno.test(
  "a previous key whose retiredAt lies more than the propagation grace ahead of the trusted clock is retired_key: the old key cannot stay an accepted issuer",
  async () => {
    const rotation = await loadAnchoredRotation();
    const max = rotation.OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS;
    const grace = rotation.OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS;

    // The adversary's shape: a plausible-looking instant far ahead of the real
    // rotation (NOW), overlap length inside the bound.
    for (const ahead of [DAY, 365 * DAY, 30 * 365 * DAY]) {
      const retiredAt = NOW + ahead;
      const ring = await rotation.importOfflineGrantKeyRing(
        ringDocument({ retiredAt, overlapEndsAt: retiredAt + max }),
      );
      // A grant the old key MINTS after the real rotation, verified the
      // instant it is minted (still more than a grace before `retiredAt`) …
      for (const lateIat of [NOW + max + 1, NOW + ahead - grace - 1]) {
        const mintedLate = await signOfflineExecutionGrant(
          moduleClaims(lateIat),
          previousSigningKey,
          moduleContext(ring.allowedKeyIds, lateIat),
        );
        await rejectWith(
          "retired_key",
          () =>
            rotation.verifyOfflineExecutionGrant(
              mintedLate,
              ring,
              moduleContext(ring.allowedKeyIds, lateIat),
            ),
          `ahead=${ahead} iat=${lateIat}`,
        );
      }
      // … and even one issued before the rotation is refused while the ring's
      // own retirement instant is not yet plausible.
      const issuedBefore = await signOfflineExecutionGrant(
        moduleClaims(NOW - DAY),
        previousSigningKey,
        moduleContext(ring.allowedKeyIds, NOW - DAY),
      );
      await rejectWith("retired_key", () =>
        rotation.verifyOfflineExecutionGrant(
          issuedBefore,
          ring,
          moduleContext(ring.allowedKeyIds, NOW),
        ),
      );
      // The active key is never affected by the previous key's window.
      const underActive = await signOfflineExecutionGrant(
        moduleClaims(NOW),
        activeSigningKey,
        moduleContext(ring.allowedKeyIds, NOW),
      );
      assertEquals(
        (
          await rotation.verifyOfflineExecutionGrant(
            underActive,
            ring,
            moduleContext(ring.allowedKeyIds, NOW + 1),
          )
        ).protectedHeader.kid,
        ACTIVE_KID,
      );
    }

    // Exact boundary: the ring is in force from `retiredAt - grace` on.
    const retiredAt = NOW + DAY;
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt, overlapEndsAt: retiredAt + DAY }),
    );
    const outstanding = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      previousSigningKey,
      moduleContext(ring.allowedKeyIds, NOW),
    );
    await rejectWith("retired_key", () =>
      rotation.verifyOfflineExecutionGrant(
        outstanding,
        ring,
        moduleContext(ring.allowedKeyIds, retiredAt - grace - 1),
      ),
    );
    for (const now of [retiredAt - grace, retiredAt, retiredAt + grace, retiredAt + DAY - 1]) {
      const verified = await rotation.verifyOfflineExecutionGrant(
        outstanding,
        ring,
        moduleContext(ring.allowedKeyIds, now),
      );
      assertEquals(verified.protectedHeader.kid, PREVIOUS_KID, String(now));
    }
    // The same rule when the key object is handed over as a list entry.
    const list: readonly OfflineGrantKey[] = [ring.activeKey, ring.previousKey!];
    await rejectWith("retired_key", () =>
      rotation.verifyOfflineExecutionGrant(
        outstanding,
        list,
        moduleContext(ring.allowedKeyIds, retiredAt - grace - 1),
      ),
    );
    assertEquals(
      (
        await rotation.verifyOfflineExecutionGrant(
          outstanding,
          list,
          moduleContext(ring.allowedKeyIds, retiredAt - grace),
        )
      ).protectedHeader.kid,
      PREVIOUS_KID,
    );
  },
);

Deno.test(
  "previous-key grants minted inside the propagation grace after retiredAt verify; one second later they are retired_key for good",
  async () => {
    const rotation = await loadAnchoredRotation();
    const grace = rotation.OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS;
    const retiredAt = NOW;
    const overlapEndsAt = retiredAt + 2 * DAY;
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt, overlapEndsAt }),
    );

    for (const iat of [retiredAt, retiredAt + 1, retiredAt + grace]) {
      const insideGrace = await signOfflineExecutionGrant(
        moduleClaims(iat),
        previousSigningKey,
        moduleContext(ring.allowedKeyIds, iat),
      );
      for (const now of [iat, iat + 1, overlapEndsAt - 1]) {
        const verified = await rotation.verifyOfflineExecutionGrant(
          insideGrace,
          ring,
          moduleContext(ring.allowedKeyIds, now),
        );
        assertEquals(verified.protectedHeader.kid, PREVIOUS_KID, `iat=${iat} now=${now}`);
      }
      await rejectWith("retired_key", () =>
        rotation.verifyOfflineExecutionGrant(
          insideGrace,
          ring,
          moduleContext(ring.allowedKeyIds, overlapEndsAt),
        ),
      );
    }

    for (const iat of [retiredAt + grace + 1, retiredAt + DAY]) {
      const tooLate = await signOfflineExecutionGrant(
        moduleClaims(iat),
        previousSigningKey,
        moduleContext(ring.allowedKeyIds, iat),
      );
      for (const now of [iat, iat + 1, overlapEndsAt - 1, overlapEndsAt]) {
        await rejectWith(
          "retired_key",
          () =>
            rotation.verifyOfflineExecutionGrant(
              tooLate,
              ring,
              moduleContext(ring.allowedKeyIds, now),
            ),
          `iat=${iat} now=${now}`,
        );
      }
    }

    // The grace never reaches past a zero-length overlap: with
    // overlapEndsAt = retiredAt nothing under the previous key verifies from
    // retiredAt on, whatever its iat.
    const closed = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt, overlapEndsAt: retiredAt }),
    );
    const atRetirement = await signOfflineExecutionGrant(
      moduleClaims(retiredAt),
      previousSigningKey,
      moduleContext(closed.allowedKeyIds, retiredAt),
    );
    await rejectWith("retired_key", () =>
      rotation.verifyOfflineExecutionGrant(
        atRetirement,
        closed,
        moduleContext(closed.allowedKeyIds, retiredAt),
      ),
    );
  },
);

Deno.test(
  "key ring import refuses a previous key that is the negation of the active point (same x): n - d would sign under the previous kid",
  async () => {
    const rotation = await loadAnchoredRotation();
    // Sanity: the negated point is on the curve and controlled by n - d — a
    // signature under it verifies with the negated public JWK.
    const negatedPublicKey = await importOfflineGrantVerificationKey(
      PREVIOUS_KID,
      negatedActivePublicJwk,
    );
    const forged = await signAs(moduleClaims(NOW), negatedActivePrivateKey, PREVIOUS_KID);
    assertEquals(
      (
        await rotation.verifyOfflineExecutionGrant(
          forged,
          [negatedPublicKey],
          moduleContext([PREVIOUS_KID], NOW + 1),
        )
      ).protectedHeader.kid,
      PREVIOUS_KID,
    );

    for (const [name, document] of [
      [
        "negated active point as previous",
        ringDocument({
          previous: {
            jwk: negatedActivePublicJwk,
            retiredAtEpochSeconds: NOW,
            overlapEndsAtEpochSeconds: NOW + DAY,
          },
        }),
      ],
      [
        "same x with an unrelated (off-curve) y",
        ringDocument({
          previous: {
            jwk: { ...previousPublicJwk, x: activePublicJwk.x },
            retiredAtEpochSeconds: NOW,
            overlapEndsAtEpochSeconds: NOW + DAY,
          },
        }),
      ],
    ] as readonly (readonly [string, unknown])[]) {
      await rejectWith("invalid_key", () => rotation.importOfflineGrantKeyRing(document), name);
    }
    // A genuinely different previous key still imports.
    const ring = await rotation.importOfflineGrantKeyRing(ringDocument({}));
    assertEquals(ring.allowedKeyIds, [ACTIVE_KID, PREVIOUS_KID]);
  },
);

// ---------------------------------------------------------------------------
// The real edge handler
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
  attestation_state: string | null;
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
    attestation_state: "unattested",
  };
}

let userSeq = 0;
/** A fresh account per test so the per-user route budget never leaks across tests. */
function freshUser(): { sub: string; token: string } {
  userSeq += 1;
  return {
    sub: `aaaaaaaa-0403-4000-8000-${String(userSeq).padStart(12, "0")}`,
    token: fakeGoogleIdToken(`aaaaaaaa-0403-4000-8000-${String(userSeq).padStart(12, "0")}`),
  };
}

function reset(secret: unknown, issuedAt = nowSeconds() - 1): void {
  h.reset();
  Deno.env.set(SIGNING_ENV, typeof secret === "string" ? secret : JSON.stringify(secret));
  h.rpcs.issue_offline_grant = [proRow(issuedAt, 3 * DAY)];
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
  "POST /v1/offline/grants with a key-ring secret signs with the ACTIVE key only",
  async () => {
    const rotation = await loadRotation();
    const user = freshUser();
    const document = ringDocument({ retiredAt: nowSeconds() - 60 });
    reset(document);
    const response = await issue(user.token);
    assertEquals(response.status, 200);
    const body = (await response.json()) as { keyId: string; grant: unknown };
    assertEquals(body.keyId, ACTIVE_KID);

    const ring = await rotation.importOfflineGrantKeyRing(document);
    const verified = await rotation.verifyOfflineExecutionGrant(
      body.grant,
      ring,
      routeContext(user.sub, ring.allowedKeyIds),
    );
    assertEquals(verified.protectedHeader.kid, ACTIVE_KID);
    assertEquals(verified.claims.sub, user.sub);
    // The active public key alone verifies it: nothing was signed with the previous key.
    await rotation.verifyOfflineExecutionGrant(
      body.grant,
      [activePublicKey],
      routeContext(user.sub, [ACTIVE_KID]),
    );
  },
);

Deno.test(
  "rotation procedure: a grant issued before the rotation verifies with the rotated ring inside the overlap and is refused after it",
  async () => {
    const rotation = await loadRotation();
    const user = freshUser();

    // Step 0 — before rotation: the previous key is the single active key.
    reset(previousPrivateJwk);
    const before = await issue(user.token);
    assertEquals(before.status, 200);
    const outstanding = (await before.json()) as { keyId: string; grant: unknown };
    assertEquals(outstanding.keyId, PREVIOUS_KID);

    // Step 1 — rotate: the new key signs, the old public key stays for one day.
    const retiredAt = nowSeconds();
    const overlapEndsAt = retiredAt + DAY;
    const document = ringDocument({ retiredAt, overlapEndsAt });
    reset(document);
    const after = await issue(user.token);
    assertEquals(after.status, 200);
    const rotated = (await after.json()) as { keyId: string; grant: unknown };
    assertEquals(rotated.keyId, ACTIVE_KID);

    const ring = await rotation.importOfflineGrantKeyRing(document);
    // The outstanding grant (3-day lease) is still verifiable inside the overlap …
    const inside = await rotation.verifyOfflineExecutionGrant(
      outstanding.grant,
      ring,
      routeContext(user.sub, ring.allowedKeyIds, overlapEndsAt - 1),
    );
    assertEquals(inside.protectedHeader.kid, PREVIOUS_KID);
    // … and refused at the end of the overlap although its lease has not expired.
    await rejectWith("retired_key", () =>
      rotation.verifyOfflineExecutionGrant(
        outstanding.grant,
        ring,
        routeContext(user.sub, ring.allowedKeyIds, overlapEndsAt),
      ),
    );
    // The grant issued after the rotation is unaffected at the same instant.
    const stillValid = await rotation.verifyOfflineExecutionGrant(
      rotated.grant,
      ring,
      routeContext(user.sub, ring.allowedKeyIds, overlapEndsAt),
    );
    assertEquals(stillValid.protectedHeader.kid, ACTIVE_KID);

    // Step 2 — retire: dropping the previous key makes its receipts invalid_key.
    const dropped = await rotation.importOfflineGrantKeyRing(ringDocument({ previous: null }));
    await rejectWith("invalid_key", () =>
      rotation.verifyOfflineExecutionGrant(
        outstanding.grant,
        dropped,
        routeContext(user.sub, [ACTIVE_KID, PREVIOUS_KID]),
      ),
    );
  },
);

Deno.test(
  "POST /v1/offline/grants answers a generic 503 and spends no grant for a malformed key ring",
  async () => {
    const rotation = await loadRotation();
    const max = rotation.OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS;
    const user = freshUser();
    const now = nowSeconds();
    for (const document of [
      ringDocument({ retiredAt: now, overlapEndsAt: now + max + 1 }),
      ringDocument({ retiredAt: now, overlapEndsAt: now - 1 }),
      ringDocument({
        previous: {
          jwk: previousPrivateJwk,
          retiredAtEpochSeconds: now,
          overlapEndsAtEpochSeconds: now + DAY,
        },
      }),
      ringDocument({
        previous: {
          jwk: { ...previousPublicJwk, kid: ACTIVE_KID },
          retiredAtEpochSeconds: now,
          overlapEndsAtEpochSeconds: now + DAY,
        },
      }),
      ringDocument({ active: activePublicJwk }),
      ringDocument({ schemaVersion: 2 }),
      { ...ringDocument({}), previousPrivateJwk },
      "not json",
    ]) {
      reset(document);
      const response = await issue(user.token);
      assertEquals(response.status, 503, JSON.stringify(document));
      const text = await response.text();
      assert(!text.includes("compactJws"));
      assert(!text.includes(SIGNING_ENV));
      assert(!text.includes(PREVIOUS_KID) && !text.includes(ACTIVE_KID));
    }
    assertEquals(h.callsTo(GRANT_RPC).length, 0);

    // The same account issues normally once the ring is well-formed again.
    reset(ringDocument({ retiredAt: now }));
    const ok = await issue(user.token);
    assertEquals(ok.status, 200);
    assertEquals(((await ok.json()) as { keyId: string }).keyId, ACTIVE_KID);
    assertEquals(h.callsTo(GRANT_RPC).length, 1);
  },
);

Deno.test(
  "POST /v1/offline/grants under an active key whose coordinates do not belong to d answers 503 and spends no grant",
  async () => {
    const user = freshUser();
    const now = nowSeconds();
    for (const document of [
      mismatchedActiveJwk,
      ringDocument({ active: mismatchedActiveJwk, previous: null }),
      ringDocument({ active: mismatchedActiveJwk, retiredAt: now - 60 }),
      { ...activePrivateJwk, x: ZERO_COORDINATE, y: ZERO_COORDINATE },
      ringDocument({
        previous: {
          jwk: { ...previousPublicJwk, x: ZERO_COORDINATE, y: ZERO_COORDINATE },
          retiredAtEpochSeconds: now - 60,
          overlapEndsAtEpochSeconds: now + DAY,
        },
      }),
      ringDocument({
        previous: {
          jwk: { ...activePublicJwk, kid: PREVIOUS_KID },
          retiredAtEpochSeconds: now - 60,
          overlapEndsAtEpochSeconds: now + DAY,
        },
      }),
    ]) {
      reset(document);
      const response = await issue(user.token);
      assertEquals(response.status, 503, JSON.stringify(document));
      const text = await response.text();
      assert(!text.includes("compactJws"));
      assert(!text.includes(SIGNING_ENV));
      assert(!text.includes(ACTIVE_KID) && !text.includes(PREVIOUS_KID));
    }
    assertEquals(h.callsTo(GRANT_RPC).length, 0);

    // The consistent key issues normally for the same account.
    reset(activePrivateJwk);
    const ok = await issue(user.token);
    assertEquals(ok.status, 200);
    assertEquals(((await ok.json()) as { keyId: string }).keyId, ACTIVE_KID);
    assertEquals(h.callsTo(GRANT_RPC).length, 1);
  },
);

Deno.test(
  "POST /v1/offline/grants answers 503 and spends no grant for a ring whose previous key is the negated active point or whose instants are not Unix seconds",
  async () => {
    const rotation = await loadAnchoredRotation();
    const max = rotation.OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS;
    const user = freshUser();
    const now = nowSeconds();
    for (const document of [
      ringDocument({
        previous: {
          jwk: negatedActivePublicJwk,
          retiredAtEpochSeconds: now - 60,
          overlapEndsAtEpochSeconds: now + DAY,
        },
      }),
      ringDocument({ retiredAt: (now - 60) * 1000, overlapEndsAt: (now - 60) * 1000 + max }),
      ringDocument({ retiredAt: now - 60, overlapEndsAt: (now + DAY) * 1000 }),
      ringDocument({
        retiredAt: Number.MAX_SAFE_INTEGER - max,
        overlapEndsAt: Number.MAX_SAFE_INTEGER,
      }),
    ]) {
      reset(document);
      const response = await issue(user.token);
      assertEquals(response.status, 503, JSON.stringify(document));
      const text = await response.text();
      assert(!text.includes("compactJws"));
      assert(!text.includes(SIGNING_ENV));
      assert(!text.includes(ACTIVE_KID) && !text.includes(PREVIOUS_KID));
    }
    assertEquals(h.callsTo(GRANT_RPC).length, 0);

    reset(ringDocument({ retiredAt: now - 60 }));
    const ok = await issue(user.token);
    assertEquals(ok.status, 200);
    assertEquals(((await ok.json()) as { keyId: string }).keyId, ACTIVE_KID);
    assertEquals(h.callsTo(GRANT_RPC).length, 1);
  },
);

Deno.test(
  "rotation procedure: a grant the SERVER issued under the old key after retiredAt but inside the propagation grace verifies inside the overlap; one issued after the grace does not",
  async () => {
    const rotation = await loadAnchoredRotation();
    const grace = rotation.OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS;
    const user = freshUser();

    // The operator reads the clock (retiredAt), assembles and dry-imports the
    // ring and runs `supabase secrets set`; the route, still on the old
    // secret, keeps issuing under the old key for a while.
    const retiredAt = nowSeconds() - 31;
    const overlapEndsAt = retiredAt + DAY;
    const duringPropagation = retiredAt + 30;
    reset(previousPrivateJwk, duringPropagation);
    const before = await issue(user.token);
    assertEquals(before.status, 200);
    const outstanding = (await before.json()) as { keyId: string; grant: unknown };
    assertEquals(outstanding.keyId, PREVIOUS_KID);
    assertEquals(h.callsTo(GRANT_RPC).length, 1, "the server spent this grant");

    // The ring lands: from here on the active key signs.
    const document = ringDocument({ retiredAt, overlapEndsAt });
    reset(document);
    const after = await issue(user.token);
    assertEquals(after.status, 200);
    assertEquals(((await after.json()) as { keyId: string }).keyId, ACTIVE_KID);

    // A device that took the spent grant offline can use it inside the overlap.
    const ring = await rotation.importOfflineGrantKeyRing(document);
    const now = nowSeconds();
    assert(now < overlapEndsAt && now < duringPropagation + 3 * DAY);
    const verified = await rotation.verifyOfflineExecutionGrant(
      outstanding.grant,
      ring,
      routeContext(user.sub, ring.allowedKeyIds, now),
    );
    assertEquals(verified.protectedHeader.kid, PREVIOUS_KID);
    assertEquals(verified.claims.iat, duringPropagation);
    // … and not once the overlap has ended.
    await rejectWith("retired_key", () =>
      rotation.verifyOfflineExecutionGrant(
        outstanding.grant,
        ring,
        routeContext(user.sub, ring.allowedKeyIds, overlapEndsAt),
      ),
    );

    // A grant the old key signs AFTER the grace is a grant the rotation was
    // meant to stop: retired_key inside the overlap too.
    const lateRetiredAt = nowSeconds() - grace - 2;
    const afterGrace = lateRetiredAt + grace + 1;
    reset(previousPrivateJwk, afterGrace);
    const late = await issue(user.token);
    assertEquals(late.status, 200);
    const minted = (await late.json()) as { keyId: string; grant: unknown };
    assertEquals(minted.keyId, PREVIOUS_KID);
    const lateRing = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt: lateRetiredAt, overlapEndsAt: lateRetiredAt + DAY }),
    );
    await rejectWith("retired_key", () =>
      rotation.verifyOfflineExecutionGrant(
        minted.grant,
        lateRing,
        routeContext(user.sub, lateRing.allowedKeyIds, nowSeconds()),
      ),
    );
  },
);

// ---------------------------------------------------------------------------
// Runbook / code consistency
// ---------------------------------------------------------------------------

Deno.test(
  "runbook: the rotation procedure names the propagation grace and the Unix-seconds bound, and no longer sets retiredAt at ring assembly",
  async () => {
    await loadAnchoredRotation();
    const runbook = await Deno.readTextFile(
      new URL("../../../../docs/runbooks/offline-key-rotation.md", import.meta.url),
    );
    assert(runbook.includes("OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS"));
    assert(runbook.includes("OFFLINE_KEY_ROTATION_MAX_EPOCH_SECONDS"));
    assert(/253[ _,]?402[ _,]?300[ _,]?799|9999-12-31/.test(runbook));
    assert(/same `?x`?|negat(ed|ion)/i.test(runbook));
    assertEquals(/the instant you will set the secret \(now\)/.test(runbook), false);
  },
);

Deno.test(
  "runbook: allowedKeyIds is verifier-side binding context — the signed payload carries no key list and the runbook does not claim it does",
  async () => {
    const rotation = await loadRotation();
    const ring = await rotation.importOfflineGrantKeyRing(ringDocument({}));
    const grant = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      ring.signingKey,
      moduleContext(ring.allowedKeyIds, NOW),
    );
    const [, payloadSegment] = grant.compactJws.split(".");
    const payload = JSON.parse(
      new TextDecoder().decode(base64url.decode(payloadSegment)),
    ) as Record<string, unknown>;
    assertEquals("allowedKeyIds" in payload, false);
    assertEquals(ring.allowedKeyIds, [ACTIVE_KID, PREVIOUS_KID]);

    const runbook = await Deno.readTextFile(
      new URL("../../../../docs/runbooks/offline-key-rotation.md", import.meta.url),
    );
    assertEquals(/grants?\s+embeds?\s+`?allowedKeyIds/i.test(runbook), false);
    assert(/verifier-side binding context/.test(runbook));
    assert(/d\/\(x,\s*y\)|belongs? to (that|its) `?d`?/.test(runbook));
  },
);
