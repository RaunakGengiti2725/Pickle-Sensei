// W04-03 adversarial suite against candidate feb7c4127a74d8fda11717721483d8f3a30d0237.
//
// Every test here is an ATTACK on a failure boundary of the key ring /
// bounded-overlap contract in ../offlineSignature.ts and its wiring in
// ../index.ts. Each test asserts the SECURE / CORRECT outcome, so a failing
// test is a confirmed break of the candidate (the failure message names it),
// and a passing test is an attack the candidate withstood. The module is
// loaded dynamically exactly like the candidate's own suite so that on
// BASE_SHA (no key ring) every test fails with an assertion, not a load error.
//
// Attacks:
//   A1  post-retirement minting — a previous-key grant with iat > retiredAt
//   A2  kid relabelling — a signature tagged with another key's kid
//   A3  far-future window — retiredAt given in milliseconds (or any far-future
//       instant) makes the "bounded" overlap unbounded in wall-clock time
//   A4  negated point — previous = (x, p − y) of the active key slips past the
//       "repeats the active key's material" refusal
//   A5  runbook gap — a grant the server itself issued under the old key after
//       the operator's retiredAt but before the ring took effect
//   A6  TOCTOU — a list-mode retired key whose window widens on re-read
//   A7  zero-length overlap, exact instants and clock rollback precedence
//   A8  route: secret cache thrash, stale-cache fallback, concurrent double
//       submit under a ring
//   A9  list-mode allowlist widening: duplicates, surplus entries, half windows

import { assert, assertEquals, assertRejects } from "@std/assert";
import { base64url, exportJWK, generateKeyPair, importJWK } from "jose";
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
const PREVIOUS_KID = "w04-03-atk-key-2026-08";
const ACTIVE_KID = "w04-03-atk-key-2026-09";
const INSTALLATION_KEY = "ios-installation-w04-03-atk";
const GRANT_ID = "55555555-0403-4555-8555-555555555555";
const DAY = 86_400;
const NOW = 1_788_000_000;

const previousPair = await generateKeyPair("ES256", { extractable: true });
const activePair = await generateKeyPair("ES256", { extractable: true });
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

const releasePolicyRow = await activeReleasePolicyRow();
const approval = releasePolicyRow.approval as { policy: { version: string; sha256: string } };
const RELEASE: OfflineReleasedArtifacts = {
  policy: approval.policy,
  mechanicsModel: HARNESS_RELEASE_POLICY.mechanics.lineage.model,
  benchmarkModel: HARNESS_RELEASE_POLICY.benchmark.lineage.model,
};
const TEST_RELEASE: OfflineReleasedArtifacts = {
  policy: { version: "w04-03-atk-policy", sha256: "d".repeat(64) },
  mechanicsModel: { version: "w04-03-atk-mechanics", sha256: "e".repeat(64) },
  benchmarkModel: { version: "w04-03-atk-benchmark", sha256: "f".repeat(64) },
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();

// ---------------------------------------------------------------------------
// Module under attack (dynamic import — see header).
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

interface Verified {
  claims: OfflineExecutionGrantClaims;
  protectedHeader: { kid: string };
}

interface RotationModule {
  OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS: number;
  importOfflineGrantKeyRing: (configured: unknown) => Promise<KeyRing>;
  verifyOfflineExecutionGrant: (
    raw: unknown,
    keys: KeyRing | readonly OfflineGrantKey[],
    expected: OfflineGrantVerificationContext,
  ) => Promise<Verified>;
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

function ringDocument(options: {
  retiredAt?: number;
  overlapEndsAt?: number;
  previous?: RetiredKeyDocument | null;
  previousJwk?: unknown;
  active?: unknown;
}): KeyRingDocument {
  const retiredAt = options.retiredAt ?? NOW;
  return {
    schemaVersion: 1,
    active: options.active ?? activePrivateJwk,
    previous:
      options.previous === undefined
        ? {
            jwk: options.previousJwk ?? previousPublicJwk,
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
      issuer: "https://w04-03-attack.invalid/grants",
      allowedKeyIds,
      ownerId: "abcdef01-2345-4678-8abc-def012345678",
      installationKeyId: INSTALLATION_KEY,
    },
    release: structuredClone(TEST_RELEASE),
    nowEpochSeconds,
  };
}

function moduleClaims(
  iat: number,
  exp = iat + OFFLINE_PRO_LEASE_MAX_SECONDS,
): OfflineExecutionGrantClaims {
  const expected = moduleContext([PREVIOUS_KID], iat);
  return {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: expected.binding.issuer,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: expected.binding.ownerId,
    jti: "w04-03-attack-grant",
    installationKeyId: INSTALLATION_KEY,
    iat,
    exp,
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

/** Signs `claims` under `key` with an arbitrary kid tag (the tag the verifier
 * will use to pick its public key). */
async function signAs(
  claims: OfflineExecutionGrantClaims,
  key: CryptoKey,
  kid: string,
  allowedKeyIds: readonly string[],
): Promise<unknown> {
  return await signOfflineExecutionGrant(
    claims,
    { purpose: "offline_execution_grant", kid, key },
    moduleContext(allowedKeyIds, claims.iat),
  );
}

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

// ---------------------------------------------------------------------------
// A1 — post-retirement minting
// ---------------------------------------------------------------------------

Deno.test(
  "A1 post-retirement minting: a previous-key grant with iat > retiredAt is retired_key even inside the overlap; iat == retiredAt is accepted",
  async () => {
    const rotation = await loadRotation();
    const retiredAt = NOW + DAY;
    const overlapEndsAt = retiredAt + 3 * DAY;
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt, overlapEndsAt }),
    );

    // Minted by the (possibly stolen) old key one second after retirement.
    const late = await signOfflineExecutionGrant(
      moduleClaims(retiredAt + 1),
      previousSigningKey,
      moduleContext(ring.allowedKeyIds, retiredAt + 1),
    );
    for (const now of [retiredAt + 1, retiredAt + DAY, overlapEndsAt - 1]) {
      await rejectWith(
        "retired_key",
        () =>
          rotation.verifyOfflineExecutionGrant(late, ring, moduleContext(ring.allowedKeyIds, now)),
        `iat = retiredAt + 1 verified at ${now}`,
      );
    }
    // The last legitimate instant of the old key is inclusive.
    const boundary = await signOfflineExecutionGrant(
      moduleClaims(retiredAt),
      previousSigningKey,
      moduleContext(ring.allowedKeyIds, retiredAt),
    );
    const verified = await rotation.verifyOfflineExecutionGrant(
      boundary,
      ring,
      moduleContext(ring.allowedKeyIds, overlapEndsAt - 1),
    );
    assertEquals(verified.protectedHeader.kid, PREVIOUS_KID);
    // The active key has no retirement rule: a late iat is fine under it.
    const activeLate = await signOfflineExecutionGrant(
      moduleClaims(retiredAt + 1),
      activeSigningKey,
      moduleContext(ring.allowedKeyIds, retiredAt + 1),
    );
    const activeVerified = await rotation.verifyOfflineExecutionGrant(
      activeLate,
      ring,
      moduleContext(ring.allowedKeyIds, overlapEndsAt + DAY),
    );
    assertEquals(activeVerified.protectedHeader.kid, ACTIVE_KID);
  },
);

// ---------------------------------------------------------------------------
// A2 — kid relabelling
// ---------------------------------------------------------------------------

Deno.test(
  "A2 kid relabelling: a previous-key signature tagged with the active kid (and vice versa) is invalid_signature — the tag cannot dodge the window",
  async () => {
    const rotation = await loadRotation();
    const retiredAt = NOW + DAY;
    const overlapEndsAt = retiredAt + DAY;
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt, overlapEndsAt }),
    );
    // Old key, minted after retirement, but tagged as the active key.
    const previousAsActive = await signAs(
      moduleClaims(retiredAt + 1),
      previousPair.privateKey,
      ACTIVE_KID,
      ring.allowedKeyIds,
    );
    for (const now of [retiredAt + 1, overlapEndsAt, overlapEndsAt + DAY]) {
      await rejectWith(
        "invalid_signature",
        () =>
          rotation.verifyOfflineExecutionGrant(
            previousAsActive,
            ring,
            moduleContext(ring.allowedKeyIds, now),
          ),
        `previous signature under active kid at ${now}`,
      );
    }
    // Active key tagged as the previous key: not accepted under the
    // previous key's rules either (it is simply not that key's signature).
    const activeAsPrevious = await signAs(
      moduleClaims(NOW),
      activePair.privateKey,
      PREVIOUS_KID,
      ring.allowedKeyIds,
    );
    await rejectWith("invalid_signature", () =>
      rotation.verifyOfflineExecutionGrant(
        activeAsPrevious,
        ring,
        moduleContext(ring.allowedKeyIds, NOW + 1),
      ),
    );
    // Same relabelled tokens against the key list form.
    const list: readonly OfflineGrantKey[] = [ring.activeKey, ring.previousKey!];
    await rejectWith("invalid_signature", () =>
      rotation.verifyOfflineExecutionGrant(
        previousAsActive,
        list,
        moduleContext(ring.allowedKeyIds, retiredAt + 1),
      ),
    );
    await rejectWith("invalid_signature", () =>
      rotation.verifyOfflineExecutionGrant(
        activeAsPrevious,
        list,
        moduleContext(ring.allowedKeyIds, NOW + 1),
      ),
    );
  },
);

// ---------------------------------------------------------------------------
// A3 — far-future window (milliseconds instead of seconds)
// ---------------------------------------------------------------------------

Deno.test(
  "A3 far-future window: retiredAt in MILLISECONDS (or any far-future instant) imports and the retired key stays verifiable more than the 7-day bound after now",
  async () => {
    const rotation = await loadRotation();
    const max = rotation.OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS;
    // Operator typo: Date.now() instead of Math.floor(Date.now() / 1000); the
    // overlap length itself stays within the bound so the length check passes.
    const retiredAtMs = NOW * 1000;
    const documents: readonly (readonly [string, KeyRingDocument])[] = [
      [
        "retiredAt in milliseconds, 7-day overlap",
        ringDocument({ retiredAt: retiredAtMs, overlapEndsAt: retiredAtMs + max }),
      ],
      [
        "retiredAt at MAX_SAFE_INTEGER - max",
        ringDocument({
          retiredAt: Number.MAX_SAFE_INTEGER - max,
          overlapEndsAt: Number.MAX_SAFE_INTEGER,
        }),
      ],
    ];
    // Every grant's own lease is at most 7 days, so the damage of an unbounded
    // window is not one long-lived receipt but that the RETIRED key never
    // stops being an accepted issuer: fresh grants minted under it long after
    // the real rotation (NOW) keep verifying.
    for (const [name, document] of documents) {
      let ring: KeyRing;
      try {
        ring = await rotation.importOfflineGrantKeyRing(document);
      } catch (error) {
        // Secure outcome: the importer refuses an implausible retirement instant.
        assert(error instanceof OfflineGrantCryptoError, name);
        assertEquals(error.code, "invalid_key", name);
        continue;
      }
      for (const lateIat of [NOW + max + 1, NOW + 365 * DAY, NOW + 30 * 365 * DAY]) {
        const mintedLate = await signOfflineExecutionGrant(
          moduleClaims(lateIat),
          previousSigningKey,
          moduleContext(ring.allowedKeyIds, lateIat),
        );
        const now = lateIat + 1;
        const outcome = await rotation
          .verifyOfflineExecutionGrant(mintedLate, ring, moduleContext(ring.allowedKeyIds, now))
          .then(
            (verified) => ({ accepted: true as const, kid: verified.protectedHeader.kid }),
            (error: unknown) => ({ accepted: false as const, error }),
          );
        assert(
          !outcome.accepted,
          `BREAK (${name}): ring imported with retiredAt=${String(
            document.previous?.retiredAtEpochSeconds,
          )} overlapEndsAt=${String(
            document.previous?.overlapEndsAtEpochSeconds,
          )}; a grant MINTED under the previous key at iat=${lateIat} (${
            lateIat - NOW
          } s after the rotation, bound is ${max} s) verified at now=${now} — the overlap is bounded only relative to an unvalidated retiredAt, so a ms-valued window keeps the retired key an accepted issuer for ~${Math.round(
            (retiredAtMs - NOW) / (365 * DAY),
          )} years`,
        );
      }
    }
  },
);

// ---------------------------------------------------------------------------
// A4 — negated point
// ---------------------------------------------------------------------------

Deno.test(
  "A4 negated point: previous = (x, p - y) of the ACTIVE key must be refused like a repeated active key — otherwise the active private scalar signs under the previous kid",
  async () => {
    const rotation = await loadRotation();
    const y = coordinateToBigInt(activePublicJwk.y!);
    const negatedPublicJwk = {
      kty: "EC",
      crv: "P-256",
      kid: PREVIOUS_KID,
      x: activePublicJwk.x,
      y: bigIntToCoordinate(P256_P - y),
    };
    const document = ringDocument({
      previousJwk: negatedPublicJwk,
      retiredAt: NOW,
      overlapEndsAt: NOW + DAY,
    });
    let ring: KeyRing;
    try {
      ring = await rotation.importOfflineGrantKeyRing(document);
    } catch (error) {
      assert(error instanceof OfflineGrantCryptoError);
      assertEquals(error.code, "invalid_key");
      return; // secure outcome
    }
    // Demonstrate the consequence: -P's private scalar is n - d, which the
    // holder of the active key computes trivially, and it signs under the
    // "previous" kid a signature the ring accepts.
    const negatedPrivate = (await importJWK(
      {
        ...negatedPublicJwk,
        d: bigIntToCoordinate(P256_N - coordinateToBigInt(activePrivateJwk.d!)),
      },
      "ES256",
      { extractable: false },
    )) as CryptoKey;
    const forged = await signAs(
      moduleClaims(NOW),
      negatedPrivate,
      PREVIOUS_KID,
      ring.allowedKeyIds,
    );
    const verified = await rotation.verifyOfflineExecutionGrant(
      forged,
      ring,
      moduleContext(ring.allowedKeyIds, NOW + 1),
    );
    assert(
      false,
      `BREAK: the ring imported a previous key that is the NEGATION of the active point (allowedKeyIds=${JSON.stringify(
        ring.allowedKeyIds,
      )}); a grant signed with n - d under kid ${verified.protectedHeader.kid} verified. The "previous entry repeats the active key's material" refusal compares (x, y) exactly and is bypassed by (x, p - y)`,
    );
  },
);

// ---------------------------------------------------------------------------
// A5 — runbook gap (real edge handler)
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
  "A5 runbook gap: a grant the SERVER issued under the old key after the operator's retiredAt (= 'now' at ring assembly) but before the ring took effect must still verify inside the overlap",
  async () => {
    const rotation = await loadRotation();
    const user = freshUser();

    // Runbook step 3: retiredAtEpochSeconds = "the instant you will set the
    // secret (now)". The operator reads the clock, assembles the document,
    // dry-imports it and runs `supabase secrets set` — 30 s pass. Meanwhile
    // the route (old secret still live) keeps issuing under the old key.
    const issuedAt = nowSeconds() - 1;
    const retiredAt = issuedAt - 30;
    const overlapEndsAt = retiredAt + DAY;
    reset(previousPrivateJwk, issuedAt);
    const before = await issue(user.token);
    assertEquals(before.status, 200);
    const outstanding = (await before.json()) as { keyId: string; grant: unknown };
    assertEquals(outstanding.keyId, PREVIOUS_KID);
    assertEquals(h.callsTo(GRANT_RPC).length, 1, "the grant was spent by the server");

    // The ring lands; from here the active key signs.
    const document = ringDocument({ retiredAt, overlapEndsAt });
    reset(document);
    const after = await issue(user.token);
    assertEquals(after.status, 200);
    assertEquals(((await after.json()) as { keyId: string }).keyId, ACTIVE_KID);

    // Inside the overlap, lease unexpired, issued by this very server under
    // the key the ring still lists: a device that took this grant offline
    // must be able to use it.
    const ring = await rotation.importOfflineGrantKeyRing(document);
    const now = nowSeconds();
    assert(now < overlapEndsAt && now < issuedAt + 3 * DAY);
    const outcome = await rotation
      .verifyOfflineExecutionGrant(
        outstanding.grant,
        ring,
        routeContext(user.sub, ring.allowedKeyIds, now),
      )
      .then(
        (verified) => ({ accepted: true as const, kid: verified.protectedHeader.kid }),
        (error: unknown) => ({
          accepted: false as const,
          code: error instanceof OfflineGrantCryptoError ? error.code : String(error),
        }),
      );
    assert(
      outcome.accepted,
      `BREAK: a grant the server issued under ${PREVIOUS_KID} at iat=${issuedAt} (${
        issuedAt - retiredAt
      } s after the runbook's retiredAt=${retiredAt}, ${
        overlapEndsAt - now
      } s of overlap left, lease unexpired) is refused as ${
        outcome.accepted ? "" : outcome.code
      }; the runbook prescribes retiredAt = now-at-assembly with no slack, so every grant issued between assembling the ring and the secret taking effect is unverifiable although the server spent it`,
    );
  },
);

// ---------------------------------------------------------------------------
// A6 — TOCTOU on a list-mode retired key
// ---------------------------------------------------------------------------

Deno.test(
  "A6 TOCTOU: a list-mode retired key whose window widens on every re-read is still refused at the first-read overlapEndsAt",
  async () => {
    const rotation = await loadRotation();
    const retiredAt = NOW + DAY;
    const overlapEndsAt = retiredAt + DAY;
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt, overlapEndsAt }),
    );
    const previousKey = ring.previousKey!;
    let overlapReads = 0;
    let retiredReads = 0;
    const shifty: OfflineGrantKey = Object.defineProperties(
      { purpose: previousKey.purpose, kid: previousKey.kid, key: previousKey.key },
      {
        retiredAtEpochSeconds: {
          enumerable: true,
          get: () => (retiredReads++ === 0 ? retiredAt : Number.MAX_SAFE_INTEGER - 7 * DAY),
        },
        overlapEndsAtEpochSeconds: {
          enumerable: true,
          get: () => (overlapReads++ === 0 ? overlapEndsAt : Number.MAX_SAFE_INTEGER),
        },
      },
    ) as OfflineGrantKey;
    const underPrevious = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      previousSigningKey,
      moduleContext(ring.allowedKeyIds, NOW),
    );
    const list: readonly OfflineGrantKey[] = [ring.activeKey, shifty];
    for (const now of [overlapEndsAt, overlapEndsAt + DAY]) {
      // Each verification sees the honest window on its FIRST read of every
      // property and a widened one on any later read.
      retiredReads = 0;
      overlapReads = 0;
      const outcome = await rotation
        .verifyOfflineExecutionGrant(underPrevious, list, moduleContext(ring.allowedKeyIds, now))
        .then(
          () => "accepted",
          (error: unknown) => (error instanceof OfflineGrantCryptoError ? error.code : "other"),
        );
      assert(
        outcome === "retired_key" || outcome === "invalid_key",
        `at now=${now} a retired key whose window mutates mid-verification was ${outcome}`,
      );
    }
    // Late-minted grant against the same shifty key: iat > first-read retiredAt.
    const late = await signOfflineExecutionGrant(
      moduleClaims(retiredAt + 1),
      previousSigningKey,
      moduleContext(ring.allowedKeyIds, retiredAt + 1),
    );
    retiredReads = 0;
    overlapReads = 0;
    const lateOutcome = await rotation
      .verifyOfflineExecutionGrant(late, list, moduleContext(ring.allowedKeyIds, retiredAt + 2))
      .then(
        () => "accepted",
        (error: unknown) => (error instanceof OfflineGrantCryptoError ? error.code : "other"),
      );
    assert(lateOutcome === "retired_key" || lateOutcome === "invalid_key", lateOutcome);
  },
);

// ---------------------------------------------------------------------------
// A7 — zero-length overlap, exact instants, clock rollback precedence
// ---------------------------------------------------------------------------

Deno.test(
  "A7 zero-length overlap and clock precedence: retiredAt == overlapEndsAt == T accepts only now < T; a rolled-back clock is invalid_time, never acceptance",
  async () => {
    const rotation = await loadRotation();
    const T = NOW + DAY;
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt: T, overlapEndsAt: T }),
    );
    const early = await signOfflineExecutionGrant(
      moduleClaims(T - 1),
      previousSigningKey,
      moduleContext(ring.allowedKeyIds, T - 1),
    );
    const atT = await signOfflineExecutionGrant(
      moduleClaims(T),
      previousSigningKey,
      moduleContext(ring.allowedKeyIds, T),
    );
    // Strictly before T: accepted (the window has not ended).
    const verified = await rotation.verifyOfflineExecutionGrant(
      early,
      ring,
      moduleContext(ring.allowedKeyIds, T - 1),
    );
    assertEquals(verified.protectedHeader.kid, PREVIOUS_KID);
    // At T and later: refused, including a grant minted exactly at T (iat == retiredAt is fine, but now >= overlapEndsAt is not).
    for (const grant of [early, atT]) {
      for (const now of [T, T + 1, T + 6 * DAY]) {
        await rejectWith(
          "retired_key",
          () =>
            rotation.verifyOfflineExecutionGrant(
              grant,
              ring,
              moduleContext(ring.allowedKeyIds, now),
            ),
          `now=${now}`,
        );
      }
    }
    // Clock rollback: verifier clock before iat — invalid_time, not an acceptance path.
    await rejectWith("invalid_time", () =>
      rotation.verifyOfflineExecutionGrant(atT, ring, moduleContext(ring.allowedKeyIds, T - 1)),
    );
    // Verifier clock at/after exp: invalid_time wins over retired_key too.
    await rejectWith("invalid_time", () =>
      rotation.verifyOfflineExecutionGrant(
        early,
        ring,
        moduleContext(ring.allowedKeyIds, moduleClaims(T - 1).exp),
      ),
    );
    // Non-integer / NaN / negative-zero clocks never reach the window logic.
    for (const now of [T - 0.5, Number.NaN, -0, Number.POSITIVE_INFINITY]) {
      await rejectWith(
        "invalid_time",
        () =>
          rotation.verifyOfflineExecutionGrant(early, ring, moduleContext(ring.allowedKeyIds, now)),
        `now=${String(now)}`,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// A8 — route: cache thrash, stale-cache fallback, double submit
// ---------------------------------------------------------------------------

Deno.test(
  "A8 route cache thrash: secret flips legacy → ring → malformed → re-serialised ring → legacy; malformed never falls back to the cached ring, every 503 spends nothing, and a concurrent double submit under the ring signs both with the active kid",
  async () => {
    const rotation = await loadRotation();
    const user = freshUser();
    const retiredAt = nowSeconds() - 60;
    const document = ringDocument({ retiredAt, overlapEndsAt: retiredAt + DAY });

    reset(previousPrivateJwk);
    const legacy = await issue(user.token);
    assertEquals(legacy.status, 200);
    assertEquals(((await legacy.json()) as { keyId: string }).keyId, PREVIOUS_KID);

    reset(document);
    const ringed = await issue(user.token);
    assertEquals(ringed.status, 200);
    assertEquals(((await ringed.json()) as { keyId: string }).keyId, ACTIVE_KID);

    // Malformed secret right after a good ring was cached: must NOT serve the
    // stale ring.
    for (const malformed of [
      JSON.stringify(document).slice(0, -1),
      JSON.stringify({
        ...document,
        previous: { ...document.previous, overlapEndsAtEpochSeconds: retiredAt + 8 * DAY },
      }),
      "",
      "   ",
      "\uFEFF" + JSON.stringify(document),
      JSON.stringify(document) + "\n{}",
    ]) {
      reset(malformed);
      const response = await issue(user.token);
      assertEquals(response.status, 503, JSON.stringify(malformed).slice(0, 60));
      const text = await response.text();
      assert(
        !text.includes(SIGNING_ENV) && !text.includes(ACTIVE_KID) && !text.includes(PREVIOUS_KID),
      );
      assertEquals(h.callsTo(GRANT_RPC).length, 0, "malformed secret spent a grant");
    }

    // Same ring, different serialisation (key order, whitespace): still signs with active.
    const reserialised = JSON.stringify(
      { previous: document.previous, active: document.active, schemaVersion: 1 },
      null,
      2,
    );
    reset(reserialised);
    const again = await issue(user.token);
    assertEquals(again.status, 200);
    const againBody = (await again.json()) as { keyId: string; grant: unknown };
    assertEquals(againBody.keyId, ACTIVE_KID);
    const ring = await rotation.importOfflineGrantKeyRing(document);
    const verified = await rotation.verifyOfflineExecutionGrant(
      againBody.grant,
      ring,
      routeContext(user.sub, ring.allowedKeyIds),
    );
    assertEquals(verified.protectedHeader.kid, ACTIVE_KID);

    // Concurrent double submit under the ring: both go through, both active.
    reset(document);
    const twin = freshUser();
    const [first, second] = await Promise.all([issue(user.token), issue(twin.token)]);
    assertEquals(first.status, 200);
    assertEquals(second.status, 200);
    assertEquals(((await first.json()) as { keyId: string }).keyId, ACTIVE_KID);
    assertEquals(((await second.json()) as { keyId: string }).keyId, ACTIVE_KID);
    assertEquals(h.callsTo(GRANT_RPC).length, 2);

    // Roll back to the legacy secret (runbook step 8): previous key signs again
    // (a fresh account: the per-user route budget is not what is under test).
    reset(previousPrivateJwk);
    const rolledBack = await issue(freshUser().token);
    assertEquals(rolledBack.status, 200);
    assertEquals(((await rolledBack.json()) as { keyId: string }).keyId, PREVIOUS_KID);
  },
);

// ---------------------------------------------------------------------------
// A9 — list-mode allowlist widening
// ---------------------------------------------------------------------------

Deno.test(
  "A9 list-mode widening: duplicate kids, entries outside the allowlist, a window with one half missing, or a private key in the list are invalid_key, not acceptance",
  async () => {
    const rotation = await loadRotation();
    const retiredAt = NOW + DAY;
    const overlapEndsAt = retiredAt + DAY;
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt, overlapEndsAt }),
    );
    const previousKey = ring.previousKey!;
    const underPrevious = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      previousSigningKey,
      moduleContext(ring.allowedKeyIds, NOW),
    );
    const allowed = ring.allowedKeyIds;
    const cases: readonly (readonly [string, readonly OfflineGrantKey[], readonly string[]])[] = [
      [
        "previous kid listed twice (second copy windowless)",
        [
          ring.activeKey,
          previousKey,
          { purpose: previousKey.purpose, kid: previousKey.kid, key: previousKey.key },
        ],
        allowed,
      ],
      [
        "more entries than the allowlist",
        [
          ring.activeKey,
          previousKey,
          { purpose: "offline_execution_grant", kid: "w04-03-atk-third", key: previousKey.key },
        ],
        allowed,
      ],
      [
        "retiredAt without overlapEndsAt",
        [
          ring.activeKey,
          {
            purpose: previousKey.purpose,
            kid: previousKey.kid,
            key: previousKey.key,
            retiredAtEpochSeconds: retiredAt,
          } as OfflineGrantKey,
        ],
        allowed,
      ],
      [
        "overlapEndsAt without retiredAt",
        [
          ring.activeKey,
          {
            purpose: previousKey.purpose,
            kid: previousKey.kid,
            key: previousKey.key,
            overlapEndsAtEpochSeconds: overlapEndsAt,
          } as OfflineGrantKey,
        ],
        allowed,
      ],
      [
        "window longer than the bound on a list entry",
        [
          ring.activeKey,
          { ...previousKey, overlapEndsAtEpochSeconds: retiredAt + 7 * DAY + 1 } as OfflineGrantKey,
        ],
        allowed,
      ],
      [
        "private previous key in the list",
        [ring.activeKey, { ...previousKey, key: previousPair.privateKey } as OfflineGrantKey],
        allowed,
      ],
    ];
    for (const [name, list, allowedKeyIds] of cases) {
      const outcome = await rotation
        .verifyOfflineExecutionGrant(
          underPrevious,
          list,
          moduleContext(allowedKeyIds, overlapEndsAt + 1),
        )
        .then(
          () => "accepted",
          (error: unknown) => (error instanceof OfflineGrantCryptoError ? error.code : "other"),
        );
      assert(outcome !== "accepted", `${name}: accepted after overlapEndsAt`);
      assert(outcome === "invalid_key" || outcome === "retired_key", `${name}: ${outcome}`);
    }
    // The windowless copy is the interesting one: alone in a list and INSIDE
    // the overlap it verifies (a caller who strips the window has widened it).
    // The ring form must not allow that: the ring's previous key always
    // carries its window.
    assertEquals(typeof ring.previousKey?.overlapEndsAtEpochSeconds, "number");
    assert(Object.isFrozen(ring.previousKey), "the ring's previous key must be frozen");
    assert(Object.isFrozen(ring), "the ring must be frozen");
  },
);
