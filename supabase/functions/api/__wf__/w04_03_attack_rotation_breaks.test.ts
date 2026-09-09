// W04-03 ADVERSARIAL — confirmed BREAKS of the candidate (d257a6af).
//
// Every test here asserts the behaviour the work package / runbook promises and
// FAILS on the candidate, reproducing a break at a rotation boundary:
//
//   B1 (P2) A verifier binding that allowlists only the ACTIVE kid rejects a
//           valid ACTIVE-key grant with `invalid_key` for as long as a previous
//           key is configured — the ring path demands allowedKeyIds ⊇ ring kids
//           (verificationKeyMap: entries.length > allowedKeyIds.length), so the
//           natural "stop honouring the old key" binding breaks every grant.
//   B2 (P2) The OfflineGrantRetiredKey produced by importOfflineGrantKeyRing
//           carries its window, but handing it to the verifier as part of a key
//           LIST (the type accepts it) silently drops the window: a previous-key
//           grant verifies after overlapEndsAt. Fail-open relative to the
//           metadata the verifier was given.
//   B3 (P3) importOfflineGrantKeyRing accepts a "rotation" whose previous PUBLIC
//           key is the active key's own public half under a different kid: a
//           compromised old private key keeps minting valid ACTIVE-kid grants
//           after the overlap. The importer should refuse identical material.
//   B4 (P3) docs/runbooks/offline-key-rotation.md states "Grants embed
//           allowedKeyIds = [active kid, previous kid] from the ring". The
//           issued grant payload carries no allowedKeyIds (the binding is
//           verifier-side only); the operator guidance is inaccurate.
//   B5 (P1) An ACTIVE private JWK whose public coordinates (x, y) do not belong
//           to its private scalar d imports as a valid ring (legacy and
//           schema-1 forms; the runbook's dry-import passes). ring.activeKey is
//           derived from x/y while ring.signingKey signs with d, so the REAL
//           route answers 200, spends the grant RPC, and hands out a grant that
//           the ring itself rejects with invalid_signature. "Malformed config
//           stays a generic 503 with no grant spent" does not hold.
//   B6 (P3) A previous PUBLIC JWK whose coordinates are not a P-256 point
//           imports (WebCrypto does not validate the point here), so every
//           previous-key grant is invalid_signature for the whole overlap: the
//           window the operator configured silently protects nothing.
//
// The module is loaded dynamically so BASE_SHA fails with assertions too.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { decodeJwt, exportJWK, generateKeyPair } from "jose";
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
const GRANT_ID = "44444444-0403-4444-8444-444444444444";
const PREVIOUS_KID = "w04-03-break-key-prev";
const ACTIVE_KID = "w04-03-break-key-active";
const INSTALLATION_KEY = "ios-installation-w04-03-break";
const DAY = 86_400;
const NOW = 1_788_000_000;

const previousPair = await generateKeyPair("ES256", { extractable: true });
const activePair = await generateKeyPair("ES256", { extractable: true });
const previousPublicJwk = { ...(await exportJWK(previousPair.publicKey)), kid: PREVIOUS_KID };
const activePrivateJwk = { ...(await exportJWK(activePair.privateKey)), kid: ACTIVE_KID };
const activePublicJwk = { ...(await exportJWK(activePair.publicKey)), kid: ACTIVE_KID };
const previousSigner: OfflineGrantKey = {
  purpose: "offline_execution_grant",
  kid: PREVIOUS_KID,
  key: previousPair.privateKey,
};
const activeSigner: OfflineGrantKey = {
  purpose: "offline_execution_grant",
  kid: ACTIVE_KID,
  key: activePair.privateKey,
};

const releasePolicyRow = await activeReleasePolicyRow();
const approval = releasePolicyRow.approval as { policy: { version: string; sha256: string } };
const RELEASE: OfflineReleasedArtifacts = {
  policy: approval.policy,
  mechanicsModel: HARNESS_RELEASE_POLICY.mechanics.lineage.model,
  benchmarkModel: HARNESS_RELEASE_POLICY.benchmark.lineage.model,
};
const TEST_RELEASE: OfflineReleasedArtifacts = {
  policy: { version: "w04-03-break-policy", sha256: "a".repeat(64) },
  mechanicsModel: { version: "w04-03-break-mechanics", sha256: "b".repeat(64) },
  benchmarkModel: { version: "w04-03-break-benchmark", sha256: "c".repeat(64) },
};

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
    typeof module.importOfflineGrantKeyRing === "function",
    "offlineSignature.ts must export importOfflineGrantKeyRing",
  );
  return module as unknown as RotationModule;
}

function ringDocument(
  previousJwk: Record<string, unknown>,
  retiredAt: number,
  overlapEndsAt: number,
) {
  return {
    schemaVersion: 1,
    active: activePrivateJwk,
    previous: {
      jwk: previousJwk,
      retiredAtEpochSeconds: retiredAt,
      overlapEndsAtEpochSeconds: overlapEndsAt,
    },
  };
}

function context(
  allowedKeyIds: readonly string[],
  nowEpochSeconds: number,
): OfflineGrantVerificationContext {
  return {
    binding: {
      issuer: "https://w04-03-break.invalid/grants",
      allowedKeyIds,
      ownerId: "12345678-1234-4234-8234-123456789abc",
      installationKeyId: INSTALLATION_KEY,
    },
    release: structuredClone(TEST_RELEASE),
    nowEpochSeconds,
  };
}

function claims(iat: number): OfflineExecutionGrantClaims {
  const expected = context([ACTIVE_KID], iat);
  return {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: expected.binding.issuer,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: expected.binding.ownerId,
    jti: "w04-03-break-grant",
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

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();

let userSeq = 0;
function freshUser(): { sub: string; token: string } {
  userSeq += 1;
  const sub = `cccccccc-0403-4000-8000-${String(userSeq).padStart(12, "0")}`;
  return { sub, token: fakeGoogleIdToken(sub) };
}

function reset(secret: unknown): void {
  h.reset();
  Deno.env.set(SIGNING_ENV, JSON.stringify(secret));
  const issuedAt = nowSeconds() - 1;
  h.rpcs.issue_offline_grant = [
    {
      result: "accepted",
      grant_id: GRANT_ID,
      generation: 1,
      entitlement_source: "verified_store",
      issued_at: iso(issuedAt),
      expires_at: iso(issuedAt + 3 * DAY),
      entitlement_expires_at: iso(issuedAt + 30 * DAY),
      ticket_ids: [],
    },
  ];
}

async function issue(token: string): Promise<Response> {
  return await h.handler(
    userRequest("POST", GRANTS_PATH, { token, body: { installationKeyId: INSTALLATION_KEY } }),
  );
}

function routeContext(
  ownerId: string,
  allowedKeyIds: readonly string[],
): OfflineGrantVerificationContext {
  return {
    binding: { issuer: ISSUER, allowedKeyIds, ownerId, installationKeyId: INSTALLATION_KEY },
    release: RELEASE,
    nowEpochSeconds: nowSeconds(),
  };
}

/** The active private JWK with the PREVIOUS key's public coordinates: `d` and
 * (x, y) belong to different keys — the shape of a copy/paste error when
 * assembling the ring document by hand. */
const mismatchedActiveJwk = { ...activePrivateJwk, x: previousPublicJwk.x, y: previousPublicJwk.y };
const ZERO_COORDINATE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

Deno.test(
  "BREAK B1 (P2): a binding that allowlists only the ACTIVE kid must still verify an ACTIVE-key grant while a previous key is configured",
  async () => {
    const rotation = await loadRotation();
    const retiredAt = NOW + DAY;
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument(previousPublicJwk, retiredAt, retiredAt + 2 * DAY),
    );
    const underActive = await signOfflineExecutionGrant(
      claims(NOW),
      activeSigner,
      context(ring.allowedKeyIds, NOW),
    );
    // Sanity: the ring-wide allowlist verifies it.
    const wide = await rotation.verifyOfflineExecutionGrant(
      underActive,
      ring,
      context(ring.allowedKeyIds, NOW + 1),
    );
    assertEquals(wide.protectedHeader.kid, ACTIVE_KID);

    // A verifier that has stopped allowlisting the retired kid (the strictest
    // binding a client can hold) still holds the ACTIVE kid the grant carries.
    // Expected: valid. Observed on d257a6af: OfflineGrantCryptoError invalid_key.
    const narrow = await rotation.verifyOfflineExecutionGrant(
      underActive,
      ring,
      context([ACTIVE_KID], NOW + 1),
    );
    assertEquals(narrow.protectedHeader.kid, ACTIVE_KID);
  },
);

Deno.test(
  "BREAK B2 (P2): a retired key handed to the verifier as a key-list entry must not verify a previous-key grant after overlapEndsAt",
  async () => {
    const rotation = await loadRotation();
    const retiredAt = NOW + DAY;
    const overlapEndsAt = retiredAt + DAY;
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument(previousPublicJwk, retiredAt, overlapEndsAt),
    );
    const previousKey = ring.previousKey;
    assert(previousKey !== null);
    assertEquals(previousKey.overlapEndsAtEpochSeconds, overlapEndsAt);
    const underPrevious = await signOfflineExecutionGrant(
      claims(NOW),
      previousSigner,
      context(ring.allowedKeyIds, NOW),
    );
    // The ring path honours the window.
    await rejectWith("retired_key", () =>
      rotation.verifyOfflineExecutionGrant(
        underPrevious,
        ring,
        context(ring.allowedKeyIds, overlapEndsAt),
      ),
    );
    // The same two key objects as a list — the type `readonly OfflineGrantKey[]`
    // accepts OfflineGrantRetiredKey — must not widen the window the retired
    // key object itself carries. Expected: retired_key (or any rejection).
    // Observed on d257a6af: accepted, protectedHeader.kid == previous kid.
    await assertRejects(
      () =>
        rotation.verifyOfflineExecutionGrant(
          underPrevious,
          [ring.activeKey, previousKey],
          context(ring.allowedKeyIds, overlapEndsAt + DAY),
        ),
      OfflineGrantCryptoError,
    );
  },
);

Deno.test(
  "BREAK B3 (P3): a previous entry carrying the ACTIVE key's own public half under another kid must be refused at import (a rotation that does not rotate)",
  async () => {
    const rotation = await loadRotation();
    const retiredAt = NOW;
    const overlapEndsAt = NOW + DAY;
    const sameMaterial = { ...activePublicJwk, kid: PREVIOUS_KID };
    // Expected: invalid_key at import. Observed on d257a6af: imports with allowedKeyIds [active, previous].
    await rejectWith("invalid_key", () =>
      rotation.importOfflineGrantKeyRing(ringDocument(sameMaterial, retiredAt, overlapEndsAt)),
    );
  },
);

Deno.test(
  "BREAK B3 consequence: with identical material the 'retired' private key keeps minting grants that verify under the ACTIVE kid after the overlap",
  async () => {
    const rotation = await loadRotation();
    const retiredAt = NOW;
    const overlapEndsAt = NOW + DAY;
    const sameMaterial = { ...activePublicJwk, kid: PREVIOUS_KID };
    let ring: KeyRing;
    try {
      ring = await rotation.importOfflineGrantKeyRing(
        ringDocument(sameMaterial, retiredAt, overlapEndsAt),
      );
    } catch (error) {
      // If the importer refuses (the expected behaviour), there is nothing further to break.
      assert(error instanceof OfflineGrantCryptoError && error.code === "invalid_key");
      return;
    }
    // The holder of the "retired" private key (== active private key here)
    // simply stamps the ACTIVE kid after the overlap: signature verifies.
    const mintedLate = await signOfflineExecutionGrant(
      claims(overlapEndsAt + DAY),
      { ...activeSigner, kid: ACTIVE_KID },
      context(ring.allowedKeyIds, overlapEndsAt + DAY),
    );
    // Expected (had the importer refused): unreachable. Documented here as the
    // consequence: the rotation window provides no protection.
    await assertRejects(
      () =>
        rotation.verifyOfflineExecutionGrant(
          mintedLate,
          ring,
          context(ring.allowedKeyIds, overlapEndsAt + DAY + 1),
        ),
      OfflineGrantCryptoError,
    );
  },
);

Deno.test(
  "BREAK B4 (P3): runbook says grants embed allowedKeyIds = [active kid, previous kid]; the signed payload must then carry them",
  async () => {
    const rotation = await loadRotation();
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument(previousPublicJwk, NOW, NOW + DAY),
    );
    const grant = (await signOfflineExecutionGrant(
      claims(NOW),
      ring.signingKey,
      context(ring.allowedKeyIds, NOW),
    )) as { compactJws: string };
    const payload = decodeJwt(grant.compactJws) as Record<string, unknown>;
    // Expected per docs/runbooks/offline-key-rotation.md ("Grants embed
    // allowedKeyIds = [active kid, previous kid] from the ring").
    // Observed on d257a6af: no such claim — the allowlist is verifier-side only.
    assertEquals(payload.allowedKeyIds, [ACTIVE_KID, PREVIOUS_KID]);
  },
);

Deno.test(
  "BREAK B5 (P1) module: an active private JWK whose x/y do not belong to d must be invalid_key at import (legacy and schema-1 forms)",
  async () => {
    const rotation = await loadRotation();
    // Expected: invalid_key for both forms. Observed on d257a6af: both import;
    // ring.signingKey signs with d, ring.activeKey verifies with (x, y).
    await rejectWith(
      "invalid_key",
      () => rotation.importOfflineGrantKeyRing(mismatchedActiveJwk),
      "legacy form",
    );
    await rejectWith(
      "invalid_key",
      () =>
        rotation.importOfflineGrantKeyRing({
          schemaVersion: 1,
          active: mismatchedActiveJwk,
          previous: null,
        }),
      "schema-1 form",
    );
  },
);

Deno.test(
  "BREAK B5 (P1) route: POST /v1/offline/grants under a d/(x,y)-inconsistent active key must not answer 200 and spend a grant that the ring itself cannot verify",
  async () => {
    const rotation = await loadRotation();
    const user = freshUser();
    reset({ schemaVersion: 1, active: mismatchedActiveJwk, previous: null });
    const response = await issue(user.token);
    if (response.status !== 200) {
      // The expected outcome: refused before any grant is spent.
      assertEquals(response.status, 503);
      assertEquals(h.callsTo(GRANT_RPC).length, 0);
      return;
    }
    // Observed on d257a6af: 200, one grant RPC spent, keyId = ACTIVE_KID …
    const body = (await response.json()) as { keyId: string; grant: unknown };
    assertEquals(body.keyId, ACTIVE_KID);
    assertEquals(h.callsTo(GRANT_RPC).length, 1);
    // … and the very ring that signed it refuses the grant: the spent grant is dead on arrival.
    const ring = await rotation.importOfflineGrantKeyRing({
      schemaVersion: 1,
      active: mismatchedActiveJwk,
      previous: null,
    });
    const verified = await rotation.verifyOfflineExecutionGrant(
      body.grant,
      ring,
      routeContext(user.sub, ring.allowedKeyIds),
    );
    assertEquals(verified.protectedHeader.kid, ACTIVE_KID);
  },
);

Deno.test(
  "BREAK B6 (P3): a previous public JWK whose coordinates are not a P-256 point must be invalid_key at import, not a window that verifies nothing",
  async () => {
    const rotation = await loadRotation();
    const offCurve = { ...previousPublicJwk, x: ZERO_COORDINATE, y: ZERO_COORDINATE };
    // Expected: invalid_key. Observed on d257a6af: imports with allowedKeyIds
    // [active, previous]; every previous-key grant is then invalid_signature
    // inside the overlap the operator configured.
    await rejectWith("invalid_key", () =>
      rotation.importOfflineGrantKeyRing(ringDocument(offCurve, NOW, NOW + DAY)),
    );
  },
);
