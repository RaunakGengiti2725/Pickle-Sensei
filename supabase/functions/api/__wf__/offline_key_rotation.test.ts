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
    const rotation = await loadRotation();
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
  return {
    sub: `aaaaaaaa-0403-4000-8000-${String(userSeq).padStart(12, "0")}`,
    token: fakeGoogleIdToken(`aaaaaaaa-0403-4000-8000-${String(userSeq).padStart(12, "0")}`),
  };
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
