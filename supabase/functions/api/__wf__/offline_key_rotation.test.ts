// W04-03 — offline signing-key rotation with a bounded overlap window.
//
// The edge fn signs offline execution grants with ONE active ES256 key and
// tags every signature with that key's `kid`. Rotation replaces the secret
// `OFFLINE_GRANT_SIGNING_JWK` with a key-ring document: the new ACTIVE private
// key plus the PREVIOUS key's PUBLIC half and an explicit overlap window
// (`retiredAtEpochSeconds` ≤ `overlapEndsAtEpochSeconds`, at most
// OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS long). Receipts/grants signed under
// the previous key verify ONLY while `now < overlapEndsAtEpochSeconds` and
// only when they were issued no later than `retiredAtEpochSeconds` plus one
// propagation grace (OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS — the
// time the old secret may still be live in some isolate after the operator
// set the ring); at and after the overlap end, or minted later than that,
// they are rejected as `retired_key` even though the signature is still
// mathematically valid. A key the ring does not know is `invalid_key`
// regardless of the window.
//
// The retirement instant is anchored to the TRUSTED clock: the importer takes
// `nowEpochSeconds` and refuses a `retiredAtEpochSeconds` later than
// now + grace (so an instant given in milliseconds, near MAX_SAFE_INTEGER or
// simply years ahead cannot turn the bounded overlap into an unbounded one),
// and the verifier applies the same bound to every retirement window it is
// handed. The previous key must be a different key: a previous point sharing
// the active key's x coordinate (the point itself or its negation (x, p − y),
// whose private scalar n − d is trivially derived from d) is `invalid_key`.
//
// Two halves, both black-box:
//   * the module contract through a dynamic import of ../offlineSignature.ts
//     (so this file loads on BASE_SHA, where the key ring does not exist and
//     every test here fails);
//   * the REAL edge handler through routesHarness: a key-ring secret signs with
//     the active key, a grant issued before rotation — including one the
//     server itself issued under the old key AFTER the operator's retirement
//     instant while the old secret was still live — still verifies with the
//     rotated ring inside the overlap and not after it, and a malformed ring
//     (private previous key, unbounded or implausible window, colliding kids,
//     negated point, unknown schema) is refused with a generic 503 before any
//     grant is spent.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { base64url, exportJWK, generateKeyPair } from "jose";
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
/** Largest instant the offline contract treats as Unix seconds (9999-12-31T23:59:59Z). */
const MAX_UNIX_SECONDS = 253_402_300_799;

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

// P-256 field prime and group order (FIPS 186-4 D.1.2.3).
const P256_P = 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n;
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function coordinateToBigInt(coordinate: string): bigint {
  return BigInt(
    "0x" +
      Array.from(base64url.decode(coordinate))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
  );
}

function bigIntToCoordinate(value: bigint): string {
  const hex = value.toString(16).padStart(64, "0");
  const bytes = Uint8Array.from(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));
  return base64url.encode(bytes);
}

/** −P of the active public point: same x, y' = p − y. Its private scalar is n − d. */
const negatedActivePublicJwk = {
  kty: "EC",
  crv: "P-256",
  kid: PREVIOUS_KID,
  x: activePublicJwk.x!,
  y: bigIntToCoordinate(P256_P - coordinateToBigInt(activePublicJwk.y!)),
};
const negatedActivePrivateJwk = {
  ...negatedActivePublicJwk,
  d: bigIntToCoordinate(P256_N - coordinateToBigInt(activePrivateJwk.d!)),
};

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

type RetiredKey = OfflineGrantKey & {
  readonly retiredAtEpochSeconds: number;
  readonly overlapEndsAtEpochSeconds: number;
};

interface KeyRing {
  readonly signingKey: OfflineGrantKey;
  readonly activeKey: OfflineGrantKey;
  readonly previousKey: RetiredKey | null;
  readonly allowedKeyIds: readonly string[];
}

interface RotationModule {
  OFFLINE_GRANT_KEY_RING_SCHEMA_VERSION: number;
  OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS: number;
  OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS: number;
  importOfflineGrantKeyRing: (configured: unknown, nowEpochSeconds: number) => Promise<KeyRing>;
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
      typeof module.OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS === "number" &&
      typeof module.OFFLINE_GRANT_KEY_RING_SCHEMA_VERSION === "number",
    "offlineSignature.ts must export importOfflineGrantKeyRing and the rotation bounds",
  );
  return module as unknown as RotationModule;
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

function previousEntry(
  jwk: unknown,
  retiredAt: number = NOW,
  overlapEndsAt: number = retiredAt + DAY,
): RetiredKeyDocument {
  return { jwk, retiredAtEpochSeconds: retiredAt, overlapEndsAtEpochSeconds: overlapEndsAt };
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

function moduleClaims(iat: number, jti = "w04-03-grant"): OfflineExecutionGrantClaims {
  const expected = moduleContext([PREVIOUS_KID], iat);
  return {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: expected.binding.issuer,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: expected.binding.ownerId,
    jti,
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

/** A grant minted under `signingKey` at `iat`, with the allowlist the signer needs. */
async function mint(signingKey: OfflineGrantKey, iat: number) {
  return await signOfflineExecutionGrant(
    moduleClaims(iat),
    signingKey,
    moduleContext([signingKey.kid], iat),
  );
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
    const rotation = await loadRotation();
    const retiredAt = NOW + DAY;
    const overlapEndsAt = retiredAt + 2 * DAY;
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt, overlapEndsAt }),
      retiredAt,
    );
    assertEquals(ring.allowedKeyIds, [ACTIVE_KID, PREVIOUS_KID]);
    assertEquals(ring.signingKey.kid, ACTIVE_KID);
    assertEquals(ring.previousKey?.retiredAtEpochSeconds, retiredAt);
    assertEquals(ring.previousKey?.overlapEndsAtEpochSeconds, overlapEndsAt);

    // Issued under the previous key BEFORE the rotation (a real outstanding grant).
    const issuedAt = NOW;
    const underPrevious = await mint(previousSigningKey, issuedAt);
    const underActive = await mint(activeSigningKey, issuedAt);

    // Inside the overlap (before retirement, at retirement, last second): accepted.
    for (const now of [issuedAt, retiredAt - 1, retiredAt, overlapEndsAt - 1]) {
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
    const underUnknown = await mint(unknownSigningKey, issuedAt);
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
    const dropped = await rotation.importOfflineGrantKeyRing(
      ringDocument({ previous: null }),
      overlapEndsAt,
    );
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
  "the retired key may not mint: a previous-key grant issued later than retiredAt + propagation grace is retired_key inside the overlap, one issued at the grace boundary is honoured",
  async () => {
    const rotation = await loadRotation();
    const grace = rotation.OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS;
    assert(Number.isSafeInteger(grace) && grace > 0 && grace <= DAY);
    const retiredAt = NOW;
    const overlapEndsAt = retiredAt + 7 * DAY;
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt, overlapEndsAt }),
      retiredAt,
    );

    // Issued by the (possibly stolen) old key one second past the grace: never
    // valid, even though the signature verifies and the overlap is wide open.
    const late = await mint(previousSigningKey, retiredAt + grace + 1);
    for (const now of [retiredAt + grace + 1, retiredAt + DAY, overlapEndsAt - 1]) {
      await rejectWith(
        "retired_key",
        () =>
          rotation.verifyOfflineExecutionGrant(late, ring, moduleContext(ring.allowedKeyIds, now)),
        String(now),
      );
    }
    // Minted a full overlap after the rotation (the prior-round A3 shape): retired_key.
    const farLate = await mint(
      previousSigningKey,
      retiredAt + rotation.OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS + 1,
    );
    await rejectWith("retired_key", () =>
      rotation.verifyOfflineExecutionGrant(
        farLate,
        ring,
        moduleContext(ring.allowedKeyIds, retiredAt + 7 * DAY + 2),
      ),
    );

    // Issued inside the grace (the old secret was still live in some isolate):
    // honoured for the whole overlap, exactly like a pre-retirement grant.
    for (const iat of [retiredAt, retiredAt + 1, retiredAt + grace]) {
      const inGrace = await mint(previousSigningKey, iat);
      for (const now of [iat, overlapEndsAt - 1]) {
        const verified = await rotation.verifyOfflineExecutionGrant(
          inGrace,
          ring,
          moduleContext(ring.allowedKeyIds, now),
        );
        assertEquals(verified.protectedHeader.kid, PREVIOUS_KID, `${iat}@${now}`);
      }
      await rejectWith("retired_key", () =>
        rotation.verifyOfflineExecutionGrant(
          inGrace,
          ring,
          moduleContext(ring.allowedKeyIds, overlapEndsAt),
        ),
      );
    }

    // The active key has no issuance cut-off.
    const activeLate = await mint(activeSigningKey, retiredAt + grace + 1);
    const verified = await rotation.verifyOfflineExecutionGrant(
      activeLate,
      ring,
      moduleContext(ring.allowedKeyIds, retiredAt + grace + 1),
    );
    assertEquals(verified.protectedHeader.kid, ACTIVE_KID);
  },
);

Deno.test(
  "a legacy single private JWK is a ring with no previous key, and the ring exposes only public verification material",
  async () => {
    const rotation = await loadRotation();
    const ring = await rotation.importOfflineGrantKeyRing(activePrivateJwk, NOW);
    assertEquals(ring.allowedKeyIds, [ACTIVE_KID]);
    assertEquals(ring.previousKey, null);
    assertEquals(ring.signingKey.kid, ACTIVE_KID);
    assertEquals(ring.signingKey.key.type, "private");
    assertEquals(ring.activeKey.kid, ACTIVE_KID);
    assertEquals(ring.activeKey.key.type, "public");
    assertEquals(ring.activeKey.key.extractable, false);
    assertEquals(ring.signingKey.key.extractable, false);
    assert(Object.isFrozen(ring));
    assert(Object.isFrozen(ring.allowedKeyIds));

    const rotated = await rotation.importOfflineGrantKeyRing(ringDocument({}), NOW);
    assertEquals(rotated.previousKey?.kid, PREVIOUS_KID);
    assertEquals(rotated.previousKey?.key.type, "public");
    assertEquals(rotated.previousKey?.key.extractable, false);
    assertEquals(rotated.previousKey?.retiredAtEpochSeconds, NOW);
    assertEquals(rotated.previousKey?.overlapEndsAtEpochSeconds, NOW + 7 * DAY);
    assert(Object.isFrozen(rotated.previousKey));

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
  "key ring import anchors the retirement instant to the trusted clock: a retiredAt later than now + grace, in milliseconds, near MAX_SAFE_INTEGER or past the contract's last instant is invalid_key",
  async () => {
    const rotation = await loadRotation();
    const grace = rotation.OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS;
    const max = rotation.OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS;

    // Accepted: a retirement up to one grace ahead of the clock, or any time in the past.
    for (const [retiredAt, now] of [
      [NOW, NOW],
      [NOW + grace, NOW],
      [NOW - 30, NOW],
      [NOW - 365 * DAY, NOW],
      [0, NOW],
    ]) {
      const ring = await rotation.importOfflineGrantKeyRing(
        ringDocument({ retiredAt, overlapEndsAt: retiredAt + max }),
        now,
      );
      assertEquals(ring.previousKey?.retiredAtEpochSeconds, retiredAt);
    }

    const rejected: readonly (readonly [string, KeyRingDocument, number])[] = [
      [
        "retiredAt one second past now + grace",
        ringDocument({ retiredAt: NOW + grace + 1, overlapEndsAt: NOW + grace + 1 + max }),
        NOW,
      ],
      ["retiredAt one day ahead", ringDocument({ retiredAt: NOW + DAY }), NOW],
      [
        "retiredAt in milliseconds",
        ringDocument({ retiredAt: NOW * 1000, overlapEndsAt: NOW * 1000 + max }),
        NOW,
      ],
      [
        "retiredAt at MAX_SAFE_INTEGER - max",
        ringDocument({
          retiredAt: Number.MAX_SAFE_INTEGER - max,
          overlapEndsAt: Number.MAX_SAFE_INTEGER,
        }),
        NOW,
      ],
      [
        "retiredAt past the contract's last instant, even against a matching clock",
        ringDocument({ retiredAt: MAX_UNIX_SECONDS + 1, overlapEndsAt: MAX_UNIX_SECONDS + 1 }),
        MAX_UNIX_SECONDS + 1,
      ],
      [
        "overlapEndsAt past the contract's last instant",
        ringDocument({ retiredAt: MAX_UNIX_SECONDS, overlapEndsAt: MAX_UNIX_SECONDS + 1 }),
        MAX_UNIX_SECONDS,
      ],
    ];
    for (const [name, document, now] of rejected) {
      await rejectWith(
        "invalid_key",
        () => rotation.importOfflineGrantKeyRing(document, now),
        name,
      );
    }

    // The clock the importer is handed must itself be a Unix-seconds instant.
    for (const now of [Number.NaN, -1, NOW + 0.5, NOW * 1000 * 1000 * 1000, "1788000000"]) {
      await rejectWith(
        "invalid_time",
        () => rotation.importOfflineGrantKeyRing(ringDocument({}), now as number),
        String(now),
      );
    }
    // A ring without a previous key has no instant to anchor but still needs a valid clock.
    await rotation.importOfflineGrantKeyRing(activePrivateJwk, NOW);
    await rejectWith("invalid_time", () =>
      rotation.importOfflineGrantKeyRing(activePrivateJwk, Number.NaN),
    );
  },
);

Deno.test(
  "key ring import enforces the bounded overlap and refuses private, colliding, unknown or malformed entries",
  async () => {
    const rotation = await loadRotation();
    const max = rotation.OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS;
    assertEquals(max, OFFLINE_PRO_LEASE_MAX_SECONDS);

    // Boundaries that are accepted: zero-length and exactly the maximum overlap.
    await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt: NOW, overlapEndsAt: NOW }),
      NOW,
    );
    await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt: NOW, overlapEndsAt: NOW + max }),
      NOW,
    );

    const rejected: readonly (readonly [string, unknown])[] = [
      ["overlap one second past the bound", ringDocument({ overlapEndsAt: NOW + max + 1 })],
      ["overlap ending before retirement", ringDocument({ overlapEndsAt: NOW - 1 })],
      ["negative retirement", ringDocument({ retiredAt: -1, overlapEndsAt: DAY })],
      ["negative zero retirement", ringDocument({ retiredAt: -0, overlapEndsAt: DAY })],
      [
        "fractional instants",
        ringDocument({ previous: previousEntry(previousPublicJwk, NOW + 0.5, NOW + DAY) }),
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
        ringDocument({ previous: previousEntry(previousPrivateJwk) }),
      ],
      [
        "previous key without a kid",
        ringDocument({ previous: previousEntry({ ...previousPublicJwk, kid: undefined }) }),
      ],
      [
        "previous kid equal to the active kid",
        ringDocument({ previous: previousEntry({ ...previousPublicJwk, kid: ACTIVE_KID }) }),
      ],
      [
        "previous key with a remote key URL",
        ringDocument({
          previous: previousEntry({ ...previousPublicJwk, jku: "https://attacker.invalid" }),
        }),
      ],
      [
        "previous entry with an unknown member",
        {
          ...ringDocument({}),
          previous: { ...previousEntry(previousPublicJwk), privateJwk: previousPrivateJwk },
        },
      ],
      [
        "previous entry smuggling d beside the jwk",
        { ...ringDocument({}), previous: { ...previousEntry(previousPublicJwk), d: activePrivateJwk.d } },
      ],
      [
        "previous entry missing its window",
        { ...ringDocument({}), previous: { jwk: previousPublicJwk } },
      ],
      [
        "previous entry missing overlapEndsAt",
        { ...ringDocument({}), previous: { jwk: previousPublicJwk, retiredAtEpochSeconds: NOW } },
      ],
      ["previous entry undefined", { schemaVersion: 1, active: activePrivateJwk }],
      ["previous entry as array", { ...ringDocument({}), previous: [previousEntry(previousPublicJwk)] }],
      ["active given as PUBLIC material", ringDocument({ active: activePublicJwk })],
      ["active without kid", ringDocument({ active: { ...activePrivateJwk, kid: undefined } })],
      ["active missing", { schemaVersion: 1, previous: null }],
      ["unknown schema version", ringDocument({ schemaVersion: 2 })],
      ["string schema version", ringDocument({ schemaVersion: "1" })],
      ["unknown top-level member", { ...ringDocument({}), previousPrivateJwk }],
      ["array", [activePrivateJwk]],
      ["null", null],
      ["undefined", undefined],
      ["string", JSON.stringify(activePrivateJwk)],
      ["bare public JWK", activePublicJwk],
    ];
    for (const [name, document] of rejected) {
      await rejectWith(
        "invalid_key",
        () => rotation.importOfflineGrantKeyRing(document, NOW),
        name,
      );
    }
  },
);

Deno.test(
  "key ring import refuses an active private JWK whose public coordinates do not belong to d (legacy and schema-1 forms)",
  async () => {
    const rotation = await loadRotation();
    // Sanity: the consistent key imports and round-trips through its own ring.
    const consistent = await rotation.importOfflineGrantKeyRing(activePrivateJwk, NOW);
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
      ["legacy form, zero scalar", { ...activePrivateJwk, d: ZERO_COORDINATE }],
      ["legacy form, scalar equal to the group order", { ...activePrivateJwk, d: bigIntToCoordinate(P256_N) }],
    ];
    for (const [name, document] of rejected) {
      await rejectWith(
        "invalid_key",
        () => rotation.importOfflineGrantKeyRing(document, NOW),
        name,
      );
    }
  },
);

Deno.test(
  "key ring import refuses a previous public JWK that is not a P-256 point, that repeats the active key's point or that is its negation (x, p − y)",
  async () => {
    const rotation = await loadRotation();
    // Sanity: the negated point IS a valid P-256 key pair (its scalar is n − d) —
    // it is refused because it shares x with the active key, not because it is malformed.
    const negatedPair = await rotation.importOfflineGrantKeyRing(
      { ...negatedActivePrivateJwk, kid: UNKNOWN_KID },
      NOW,
    );
    assertEquals(negatedPair.signingKey.kid, UNKNOWN_KID);

    const rejected: readonly (readonly [string, unknown])[] = [
      [
        "previous coordinates not on the curve",
        ringDocument({
          previous: previousEntry({ ...previousPublicJwk, x: ZERO_COORDINATE, y: ZERO_COORDINATE }),
        }),
      ],
      [
        "previous y of another key",
        ringDocument({ previous: previousEntry({ ...previousPublicJwk, y: unknownPublicJwk.y }) }),
      ],
      [
        "previous entry is the active public half under another kid",
        ringDocument({ previous: previousEntry({ ...activePublicJwk, kid: PREVIOUS_KID }) }),
      ],
      [
        "previous entry is the NEGATED active point (x, p − y) under another kid",
        ringDocument({ previous: previousEntry(negatedActivePublicJwk) }),
      ],
      [
        "previous entry shares the active x with an off-curve y",
        ringDocument({
          previous: previousEntry({ ...activePublicJwk, kid: PREVIOUS_KID, y: ZERO_COORDINATE }),
        }),
      ],
    ];
    for (const [name, document] of rejected) {
      await rejectWith(
        "invalid_key",
        () => rotation.importOfflineGrantKeyRing(document, NOW),
        name,
      );
    }

    // Consequence: a grant signed with n − d under the previous kid has no ring
    // that honours it — the only ring naming that kid with that point is refused.
    const negatedSigningKey: OfflineGrantKey = {
      purpose: "offline_execution_grant",
      kid: PREVIOUS_KID,
      key: (await rotation.importOfflineGrantKeyRing({ ...negatedActivePrivateJwk }, NOW)).signingKey
        .key,
    };
    const forged = await mint(negatedSigningKey, NOW);
    const honest = await rotation.importOfflineGrantKeyRing(ringDocument({}), NOW);
    await rejectWith("invalid_signature", () =>
      rotation.verifyOfflineExecutionGrant(forged, honest, moduleContext(honest.allowedKeyIds, NOW)),
    );
  },
);

Deno.test(
  "a binding that allowlists only the active kid still verifies active-key grants through a ring with a previous key",
  async () => {
    const rotation = await loadRotation();
    const retiredAt = NOW + DAY;
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt, overlapEndsAt: retiredAt + 2 * DAY }),
      retiredAt,
    );
    const underActive = await mint(activeSigningKey, NOW);
    const underPrevious = await mint(previousSigningKey, NOW);
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
    // And the reverse narrowing keeps the previous key usable inside its window.
    const previousOnly = await rotation.verifyOfflineExecutionGrant(
      underPrevious,
      ring,
      moduleContext([PREVIOUS_KID], NOW + 1),
    );
    assertEquals(previousOnly.protectedHeader.kid, PREVIOUS_KID);
    await rejectWith("invalid_metadata", () =>
      rotation.verifyOfflineExecutionGrant(
        underActive,
        ring,
        moduleContext([PREVIOUS_KID], NOW + 1),
      ),
    );
  },
);

Deno.test(
  "the previous key's window travels with the key object: as a list entry it still refuses receipts after overlapEndsAt or minted past the grace, and an implausible or widened window is invalid_key",
  async () => {
    const rotation = await loadRotation();
    const grace = rotation.OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS;
    const max = rotation.OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS;
    const retiredAt = NOW + DAY;
    const overlapEndsAt = retiredAt + DAY;
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt, overlapEndsAt }),
      retiredAt,
    );
    const previousKey = ring.previousKey;
    assert(previousKey !== null);
    const underPrevious = await mint(previousSigningKey, NOW);
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
    const late = await mint(previousSigningKey, retiredAt + grace + 1);
    await rejectWith("retired_key", () =>
      rotation.verifyOfflineExecutionGrant(
        late,
        list,
        moduleContext(ring.allowedKeyIds, retiredAt + grace + 2),
      ),
    );

    // The window is read once, before any asynchronous cryptography: a key
    // object whose window widens mid-verification is still refused at the
    // first-read overlapEndsAt.
    const mutable = { ...previousKey };
    const pending = rotation.verifyOfflineExecutionGrant(
      underPrevious,
      [ring.activeKey, mutable],
      moduleContext(ring.allowedKeyIds, overlapEndsAt),
    );
    mutable.overlapEndsAtEpochSeconds = overlapEndsAt + DAY;
    await rejectWith("retired_key", () => pending);

    // A list entry with a partial, unbounded, implausible or clock-defying
    // window is a malformed key, whichever kid the grant presents.
    for (const [name, entry] of [
      ["missing overlapEndsAt", { ...previousKey, overlapEndsAtEpochSeconds: undefined }],
      ["missing retiredAt", { ...previousKey, retiredAtEpochSeconds: undefined }],
      ["overlap past the bound", { ...previousKey, overlapEndsAtEpochSeconds: retiredAt + max + 1 }],
      ["overlap before retirement", { ...previousKey, overlapEndsAtEpochSeconds: retiredAt - 1 }],
      ["string retiredAt", { ...previousKey, retiredAtEpochSeconds: String(retiredAt) }],
      [
        "retiredAt in milliseconds",
        {
          ...previousKey,
          retiredAtEpochSeconds: retiredAt * 1000,
          overlapEndsAtEpochSeconds: retiredAt * 1000 + max,
        },
      ],
      [
        "retiredAt later than now + grace",
        {
          ...previousKey,
          retiredAtEpochSeconds: NOW + grace + 1,
          overlapEndsAtEpochSeconds: NOW + grace + 1 + max,
        },
      ],
    ] as readonly (readonly [string, unknown])[]) {
      const entries = [ring.activeKey, entry as OfflineGrantKey];
      await rejectWith(
        "invalid_key",
        () =>
          rotation.verifyOfflineExecutionGrant(
            underPrevious,
            entries,
            moduleContext(ring.allowedKeyIds, NOW),
          ),
        name,
      );
      const underActive = await mint(activeSigningKey, NOW);
      await rejectWith(
        "invalid_key",
        () =>
          rotation.verifyOfflineExecutionGrant(
            underActive,
            entries,
            moduleContext(ring.allowedKeyIds, NOW),
          ),
        `${name} (active grant)`,
      );
    }
    // A retirement exactly one grace ahead of the verifier's clock is the accepted edge.
    const edge = { ...previousKey, retiredAtEpochSeconds: NOW + grace, overlapEndsAtEpochSeconds: NOW + grace + DAY };
    const atEdge = await rotation.verifyOfflineExecutionGrant(
      underPrevious,
      [ring.activeKey, edge],
      moduleContext(ring.allowedKeyIds, NOW),
    );
    assertEquals(atEdge.protectedHeader.kid, PREVIOUS_KID);
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
/** A fresh account per test so the per-user route budget never leaks across tests. */
function freshUser(): { sub: string; token: string } {
  userSeq += 1;
  const sub = `aaaaaaaa-0403-4000-8000-${String(userSeq).padStart(12, "0")}`;
  return { sub, token: fakeGoogleIdToken(sub) };
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

    const ring = await rotation.importOfflineGrantKeyRing(document, nowSeconds());
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
  "rotation procedure: grants issued before the rotation — including one the server issued under the old key inside the propagation grace after retiredAt — verify with the rotated ring inside the overlap and are refused after it",
  async () => {
    const rotation = await loadRotation();
    const user = freshUser();

    // Step 0 — before rotation: the previous key is the single active key.
    reset(previousPrivateJwk);
    const before = await issue(user.token);
    assertEquals(before.status, 200);
    const outstanding = (await before.json()) as { keyId: string; grant: unknown };
    assertEquals(outstanding.keyId, PREVIOUS_KID);

    // Step 1 — the operator reads the clock (retiredAt), assembles the ring and
    // runs `supabase secrets set`. The old secret stays live in this isolate for
    // another 30 s and the route keeps issuing under the old key — spent by the
    // server, held by a device that may now be offline.
    const retiredAt = nowSeconds() - 31;
    const overlapEndsAt = retiredAt + DAY;
    reset(previousPrivateJwk, retiredAt + 30);
    const during = await issue(user.token);
    assertEquals(during.status, 200);
    const propagated = (await during.json()) as { keyId: string; grant: unknown };
    assertEquals(propagated.keyId, PREVIOUS_KID);
    assertEquals(h.callsTo(GRANT_RPC).length, 1, "the grant was spent by the server");

    // Step 2 — the ring lands: the new key signs, the old public key stays for one day.
    const document = ringDocument({ retiredAt, overlapEndsAt });
    reset(document);
    const after = await issue(user.token);
    assertEquals(after.status, 200);
    const rotated = (await after.json()) as { keyId: string; grant: unknown };
    assertEquals(rotated.keyId, ACTIVE_KID);

    const ring = await rotation.importOfflineGrantKeyRing(document, nowSeconds());
    // Both outstanding grants (3-day leases) are still verifiable inside the overlap …
    for (const [name, grant] of [
      ["issued before retiredAt", outstanding.grant],
      ["issued 30 s after retiredAt while the old secret was live", propagated.grant],
    ] as const) {
      for (const now of [nowSeconds(), overlapEndsAt - 1]) {
        const inside = await rotation.verifyOfflineExecutionGrant(
          grant,
          ring,
          routeContext(user.sub, ring.allowedKeyIds, now),
        );
        assertEquals(inside.protectedHeader.kid, PREVIOUS_KID, `${name} @ ${now}`);
      }
      // … and refused at the end of the overlap although their leases have not expired.
      await rejectWith(
        "retired_key",
        () =>
          rotation.verifyOfflineExecutionGrant(
            grant,
            ring,
            routeContext(user.sub, ring.allowedKeyIds, overlapEndsAt),
          ),
        name,
      );
    }
    // The grant issued after the rotation is unaffected at the same instant.
    const stillValid = await rotation.verifyOfflineExecutionGrant(
      rotated.grant,
      ring,
      routeContext(user.sub, ring.allowedKeyIds, overlapEndsAt),
    );
    assertEquals(stillValid.protectedHeader.kid, ACTIVE_KID);

    // Step 3 — retire: dropping the previous key makes its receipts invalid_key.
    const dropped = await rotation.importOfflineGrantKeyRing(
      ringDocument({ previous: null }),
      nowSeconds(),
    );
    for (const grant of [outstanding.grant, propagated.grant]) {
      await rejectWith("invalid_key", () =>
        rotation.verifyOfflineExecutionGrant(
          grant,
          dropped,
          routeContext(user.sub, [ACTIVE_KID, PREVIOUS_KID]),
        ),
      );
    }
  },
);

Deno.test(
  "POST /v1/offline/grants answers a generic 503 and spends no grant for a malformed key ring",
  async () => {
    const rotation = await loadRotation();
    const max = rotation.OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS;
    const grace = rotation.OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS;
    const user = freshUser();
    const now = nowSeconds();
    for (const document of [
      ringDocument({ retiredAt: now, overlapEndsAt: now + max + 1 }),
      ringDocument({ retiredAt: now, overlapEndsAt: now - 1 }),
      // The route anchors the ring to its own clock: a retirement more than one
      // grace ahead, in milliseconds or near MAX_SAFE_INTEGER never signs.
      ringDocument({ retiredAt: now + grace + 60 }),
      ringDocument({ retiredAt: now * 1000, overlapEndsAt: now * 1000 + max }),
      ringDocument({
        retiredAt: Number.MAX_SAFE_INTEGER - max,
        overlapEndsAt: Number.MAX_SAFE_INTEGER,
      }),
      ringDocument({ previous: previousEntry(previousPrivateJwk, now, now + DAY) }),
      ringDocument({
        previous: previousEntry({ ...previousPublicJwk, kid: ACTIVE_KID }, now, now + DAY),
      }),
      ringDocument({ previous: previousEntry(negatedActivePublicJwk, now - 60, now + DAY) }),
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

    // The same account issues normally once the ring is well-formed again — and
    // a retirement inside the grace is accepted.
    reset(ringDocument({ retiredAt: now + grace - 60 }));
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
        previous: previousEntry(
          { ...previousPublicJwk, x: ZERO_COORDINATE, y: ZERO_COORDINATE },
          now - 60,
          now + DAY,
        ),
      }),
      ringDocument({
        previous: previousEntry({ ...activePublicJwk, kid: PREVIOUS_KID }, now - 60, now + DAY),
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

// ---------------------------------------------------------------------------
// Runbook / code consistency
// ---------------------------------------------------------------------------

Deno.test(
  "runbook: allowedKeyIds is verifier-side binding context, the retirement instant is the secret-set instant with the code's propagation grace, and the previous key must differ in x",
  async () => {
    const rotation = await loadRotation();
    const ring = await rotation.importOfflineGrantKeyRing(ringDocument({}), NOW);
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
    // The documented numbers are the code's numbers.
    assert(runbook.includes("OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS"));
    assert(
      runbook.includes(`${rotation.OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS} s`) ||
        runbook.includes(`${rotation.OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS} seconds`),
    );
    assert(runbook.includes("OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS"));
    assert(/\(x,\s*p\s*[-−]\s*y\)/.test(runbook), "the runbook names the negated-point refusal");
    // The runbook must not prescribe an unanchored "now" without the grace.
    assert(/grace/i.test(runbook));
  },
);
