/**
 * INT-offline-lease adversary — crypto / validator attacks on the offline
 * execution-grant envelope, receipt binding and reconciliation contract at
 * integration head 30a4065036a917514fb4984fde73f87867f38619.
 *
 * Pure WebCrypto + the shipped validators; no network, no Postgres.
 *
 *   cd supabase/functions/api && npx --yes deno@2.5.6 test --no-prompt --frozen \
 *     --lock=deno.lock __wf__/xc_offline_grant_crypto_adversary.test.ts
 *
 * A FAILING test is a reproduced break; a passing test is evidence the
 * boundary holds. Attacks:
 *   OL-CR-1  ECDSA signature malleability: the high-S twin (s' = n - s) of a
 *            valid grant signature must be rejected, otherwise one issued
 *            grant has two distinct compact JWS forms / grantJwsSha256 values
 *            and any digest-keyed replay ledger can be bypassed.
 *   OL-CR-2  key-rotation confusion: a token signed by the ROTATED key but
 *            labelled with the old kid (and vice versa), a revoked kid still
 *            present in the key list, and a kid that only the token knows.
 *   OL-CR-3  clock rollback / skew at verification: nowEpochSeconds one
 *            second before iat, exactly at exp, fractional, negative zero, and
 *            an iat in the future are all invalid_time; the last valid second
 *            (exp - 1) still verifies.
 *   OL-CR-4  lease bounds under a rolled-back server clock: signing refuses
 *            exp - iat > 7d, a subscription lease past verified entitlement
 *            expiry, and a LIFETIME lease > 7d; the exact 7d lease signs.
 *   OL-CR-5  receipt anchor rollback: a receipt whose trusted time anchor was
 *            issued before the grant, or whose elapsed time crosses exp, is
 *            refused; a replayed lifecycle sequence is refused; the receipt
 *            digest must match the verified envelope (not the malleated one).
 *   OL-CR-6  reconciliation with conflicting server state: a pending
 *            ticketed receipt can only be 'reserved'; a not_chargeable
 *            result can never be 'consumed'; an unused-ticket status cannot
 *            carry a consumed/result disposition; owner mismatch is refused.
 *   OL-CR-7  free execution grants: is there ANY cap on exp - iat? (The Pro
 *            lease is capped at 7d; the free allocation's financial expiry is
 *            reconciliation_only, but its EXECUTION window is a grant claim.)
 */
import assert from "node:assert/strict";
import { base64url, CompactSign, exportJWK, generateKeyPair } from "jose";
import {
  ANALYSIS_ELIGIBILITY_INPUT_SCHEMA_VERSION,
  ANALYSIS_OUTCOME_SCHEMA_VERSION,
  type AnalysisOutcome,
  type IndependentlyVerifiedAnalysisEligibility,
  MECHANICS_OUTPUT_SCHEMA_VERSION,
} from "../../../../packages/shared-types/src/analysisOutcome.ts";
import {
  type NumericalOutputLineage,
  TECHNIQUE_BENCHMARK_INTERPRETATION,
  TECHNIQUE_BENCHMARK_SCALE,
  TECHNIQUE_BENCHMARK_SCHEMA_VERSION,
} from "../../../../packages/shared-types/src/techniqueBenchmark.ts";
import {
  OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION,
  OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
  OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
  OFFLINE_FREE_ALLOCATION_POLICY,
  OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
  OFFLINE_GRANT_AUDIENCE,
  OFFLINE_GRANT_JWS_TYPE,
  OFFLINE_JWS_REQUIREMENTS,
  OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
  OFFLINE_PRO_LEASE_MAX_SECONDS,
  OFFLINE_PRO_LEASE_SCHEMA_VERSION,
  OFFLINE_RECONCILIATION_SCHEMA_VERSION,
  OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
  OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
  OFFLINE_TIME_ANCHOR_SCHEMA_VERSION,
  type OfflineExecutionGrantClaims,
  type OfflineReceiptBinding,
  type OfflineResultBinding,
  type OfflineSignedExecutionGrant,
  validateOfflineReconciliationStatus,
  validateOfflineResultReceiptBinding,
} from "../../../../packages/shared-types/src/offlineAuthorization.ts";
import { digestOfflineGrantTransport } from "../canonicalDigest.ts";
import {
  importOfflineGrantVerificationKey,
  OfflineGrantCryptoError,
  type OfflineGrantKey,
  type OfflineGrantVerificationContext,
  signOfflineExecutionGrant,
  verifyOfflineExecutionGrant,
} from "../offlineSignature.ts";

const OWNER = "12345678-1234-4234-8234-123456789abc";
const OTHER_OWNER = "87654321-4321-4321-8321-cba987654321";
const KID = "adv-offline-grant-key";
const ROTATED_KID = "adv-offline-grant-key-rotated";
const NOW = 1_788_000_000;
const HASH = "a".repeat(64);
const RELEASE = {
  policy: { version: "adv-policy-1", sha256: "a".repeat(64) },
  mechanicsModel: { version: "adv-mechanics-1", sha256: "b".repeat(64) },
  benchmarkModel: { version: "adv-benchmark-1", sha256: "c".repeat(64) },
};
/** secp256r1 group order. */
const P256_N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");

const keyPair = await generateKeyPair("ES256", { extractable: true });
const rotatedPair = await generateKeyPair("ES256", { extractable: true });
const signingKey: OfflineGrantKey = {
  purpose: OFFLINE_JWS_REQUIREMENTS.keyPurpose,
  kid: KID,
  key: keyPair.privateKey,
};
const rotatedSigningKey: OfflineGrantKey = {
  purpose: OFFLINE_JWS_REQUIREMENTS.keyPurpose,
  kid: ROTATED_KID,
  key: rotatedPair.privateKey,
};
const publicKey = await importOfflineGrantVerificationKey(KID, await exportJWK(keyPair.publicKey));
const rotatedKey = await importOfflineGrantVerificationKey(
  ROTATED_KID,
  await exportJWK(rotatedPair.publicKey),
);

function context(
  overrides: Partial<OfflineGrantVerificationContext> = {},
  allowedKeyIds: readonly string[] = [KID, ROTATED_KID],
): OfflineGrantVerificationContext {
  return {
    binding: {
      issuer: "https://adv-offline.invalid/grants",
      allowedKeyIds: [...allowedKeyIds],
      ownerId: OWNER,
      installationKeyId: "adv-installation-key",
    },
    release: structuredClone(RELEASE),
    nowEpochSeconds: NOW,
    ...overrides,
  };
}

function freeClaims(): Extract<
  OfflineExecutionGrantClaims,
  { entitlementSource: "identity_lifetime_free" }
> {
  return {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: context().binding.issuer,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: OWNER,
    jti: "adv-grant-id",
    installationKeyId: context().binding.installationKeyId,
    iat: NOW,
    exp: NOW + OFFLINE_PRO_LEASE_MAX_SECONDS,
    capabilities: ["analyze_joint_output"],
    release: structuredClone(RELEASE),
    entitlementSource: "identity_lifetime_free",
    allocation: {
      schemaVersion: OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
      allocationId: "adv-allocation-id",
      generation: 1,
      ticketIds: ["adv-ticket-1"],
      budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
      financialExpiry: "reconciliation_only",
    },
  };
}

function proClaims(
  kind: "subscription" | "lifetime",
  verifiedEntitlementExpiresAt: number | null,
  exp = NOW + OFFLINE_PRO_LEASE_MAX_SECONDS,
): Extract<OfflineExecutionGrantClaims, { entitlementSource: "verified_store" }> {
  const { allocation: _allocation, ...base } = freeClaims();
  return {
    ...base,
    exp,
    entitlementSource: "verified_store",
    lease: {
      schemaVersion: OFFLINE_PRO_LEASE_SCHEMA_VERSION,
      kind,
      verifiedEntitlementExpiresAt,
    } as Extract<OfflineExecutionGrantClaims, { entitlementSource: "verified_store" }>["lease"],
  };
}

function transport(compactJws: string): OfflineSignedExecutionGrant {
  return { schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION, compactJws };
}

async function forge(
  payload: unknown,
  key: CryptoKey,
  kid: string,
): Promise<OfflineSignedExecutionGrant> {
  return transport(
    await new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: "ES256", typ: OFFLINE_GRANT_JWS_TYPE, kid })
      .sign(key),
  );
}

async function rejects(
  promise: Promise<unknown>,
  code: OfflineGrantCryptoError["code"],
  label: string,
): Promise<void> {
  await assert.rejects(promise, { name: "OfflineGrantCryptoError", code }, label);
}

function bigIntFromBytes(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bytesFromBigInt(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** The other valid ECDSA signature for the same (r, message): s' = n - s. */
function highSTwin(grant: OfflineSignedExecutionGrant): OfflineSignedExecutionGrant {
  const [h, p, sig] = grant.compactJws.split(".");
  const raw = base64url.decode(sig);
  assert.equal(raw.length, 64, "ES256 JWS signature is r||s (64 bytes)");
  const r = raw.slice(0, 32);
  const s = bigIntFromBytes(raw.slice(32));
  const twin = new Uint8Array(64);
  twin.set(r, 0);
  twin.set(bytesFromBigInt(P256_N - s, 32), 32);
  return transport(`${h}.${p}.${base64url.encode(twin)}`);
}

const valid = await signOfflineExecutionGrant(freeClaims(), signingKey, context());

Deno.test("OL-CR-1: the high-S twin of a valid grant signature is rejected (one grant ⇒ one compact JWS ⇒ one grantJwsSha256)", async () => {
  const verified = await verifyOfflineExecutionGrant(valid, [publicKey], context());
  const twin = highSTwin(valid);
  assert.notEqual(twin.compactJws, valid.compactJws);
  const twinDigest = await digestOfflineGrantTransport(twin);
  assert.notEqual(twinDigest, verified.grantJwsSha256, "malleated envelope has a distinct digest");
  let twinVerdict: string;
  try {
    const twinVerified = await verifyOfflineExecutionGrant(twin, [publicKey], context());
    twinVerdict =
      `ACCEPTED jti=${twinVerified.claims.jti} grantJwsSha256=${twinVerified.grantJwsSha256} (original ${verified.grantJwsSha256})`;
  } catch (error) {
    twinVerdict = error instanceof OfflineGrantCryptoError ? error.code : String(error);
  }
  assert.equal(
    twinVerdict,
    "invalid_signature",
    `high-S signature twin: ${twinVerdict} — one issued grant has two verifying envelopes / digests`,
  );
  // The twin of the twin is the original again — sanity check on the arithmetic.
  assert.equal(highSTwin(twin).compactJws, valid.compactJws);
});

Deno.test("OL-CR-2: key rotation — kid/key mismatch, revoked kid still loaded, and token-only kid are all refused; the legitimately rotated grant verifies", async () => {
  const keys = [publicKey, rotatedKey];
  // Signed with the rotated private key but labelled with the old kid.
  await rejects(
    verifyOfflineExecutionGrant(
      await forge(freeClaims(), rotatedPair.privateKey, KID),
      keys,
      context(),
    ),
    "invalid_signature",
    "rotated key under old kid",
  );
  // Signed with the old private key but labelled with the rotated kid.
  await rejects(
    verifyOfflineExecutionGrant(
      await forge(freeClaims(), keyPair.privateKey, ROTATED_KID),
      keys,
      context(),
    ),
    "invalid_signature",
    "old key under rotated kid",
  );
  // The old kid is revoked from the binding but its key object is still in
  // the loaded key list: the binding wins.
  await rejects(
    verifyOfflineExecutionGrant(valid, keys, context({}, [ROTATED_KID])),
    "invalid_metadata",
    "revoked kid still verifies",
  );
  // A kid the token invents, signed by a real key.
  await rejects(
    verifyOfflineExecutionGrant(
      await forge(freeClaims(), keyPair.privateKey, "adv-unknown-kid"),
      keys,
      context(),
    ),
    "invalid_metadata",
    "unknown kid",
  );
  // Rotated key object presented under the OLD kid in the key list itself.
  const mislabeled: OfflineGrantKey = { ...rotatedKey, kid: KID };
  await rejects(
    verifyOfflineExecutionGrant(valid, [mislabeled], context()),
    "invalid_signature",
    "mislabeled key object",
  );
  // Legitimate rotation: server signs with the rotated key, both kids allowed.
  const rotated = await signOfflineExecutionGrant(freeClaims(), rotatedSigningKey, context());
  const verified = await verifyOfflineExecutionGrant(rotated, keys, context());
  assert.equal(verified.protectedHeader.kid, ROTATED_KID);
  // …and once the old kid is retired the old grant dies with it.
  await rejects(
    verifyOfflineExecutionGrant(valid, [rotatedKey], context({}, [ROTATED_KID])),
    "invalid_metadata",
    "retired kid grant",
  );
});

Deno.test("OL-CR-3: clock rollback / skew at verification is invalid_time on both sides; exp is exclusive; exp-1 is the last valid second", async () => {
  const claims = freeClaims();
  const cases: Array<[number, string]> = [
    [claims.iat - 1, "device clock rolled back 1s before iat"],
    [claims.exp, "exactly at exp"],
    [claims.exp + 1, "after exp"],
    [claims.iat + 0.5, "fractional now"],
    [-0, "negative zero"],
    [Number.NaN, "NaN"],
    [Number.MAX_SAFE_INTEGER + 1, "unsafe integer"],
  ];
  for (const [now, label] of cases) {
    await rejects(
      verifyOfflineExecutionGrant(valid, [publicKey], context({ nowEpochSeconds: now })),
      "invalid_time",
      label,
    );
  }
  for (const now of [claims.iat, claims.exp - 1]) {
    const verified = await verifyOfflineExecutionGrant(
      valid,
      [publicKey],
      context({ nowEpochSeconds: now }),
    );
    assert.equal(verified.claims.jti, claims.jti);
  }
  // Signing refuses to mint a grant dated in the future or already expired
  // relative to the trusted server clock.
  await rejects(
    signOfflineExecutionGrant(
      { ...claims, iat: NOW + 1, exp: NOW + 1 + 3600 },
      signingKey,
      context(),
    ),
    "invalid_time",
    "future iat",
  );
  await rejects(
    signOfflineExecutionGrant(claims, signingKey, context({ nowEpochSeconds: claims.exp })),
    "invalid_time",
    "already expired at mint",
  );
  // A forged token with a future iat cannot be verified "now" either.
  await rejects(
    verifyOfflineExecutionGrant(
      await forge({ ...claims, iat: NOW + 1, exp: NOW + 3600 }, keyPair.privateKey, KID),
      [publicKey],
      context(),
    ),
    "invalid_time",
    "forged future iat",
  );
});

Deno.test("OL-CR-4: lease bounds — > 7d, > verified entitlement expiry, lifetime > 7d, exp == entitlement expiry+1 all refuse to sign or verify; exact 7d and exp == entitlement expiry sign", async () => {
  const sevenDays = OFFLINE_PRO_LEASE_MAX_SECONDS;
  // 7d + 1s subscription lease with a generous entitlement.
  await rejects(
    signOfflineExecutionGrant(
      proClaims("subscription", NOW + sevenDays * 4, NOW + sevenDays + 1),
      signingKey,
      context(),
    ),
    "invalid_metadata",
    "subscription lease 7d+1s",
  );
  // Lifetime purchase: still capped at 7d.
  await rejects(
    signOfflineExecutionGrant(
      proClaims("lifetime", null, NOW + sevenDays + 1),
      signingKey,
      context(),
    ),
    "invalid_metadata",
    "lifetime lease 7d+1s",
  );
  // Subscription expiring in 1h, lease asks for 1h + 1s.
  await rejects(
    signOfflineExecutionGrant(
      proClaims("subscription", NOW + 3600, NOW + 3601),
      signingKey,
      context(),
    ),
    "invalid_metadata",
    "lease outlives entitlement by 1s",
  );
  // Entitlement already expired at mint time.
  await rejects(
    signOfflineExecutionGrant(proClaims("subscription", NOW - 1, NOW + 60), signingKey, context()),
    "invalid_metadata",
    "expired entitlement",
  );
  // Lifetime lease may not carry a numeric expiry; subscription may not carry null.
  await rejects(
    signOfflineExecutionGrant(proClaims("lifetime", NOW + sevenDays), signingKey, context()),
    "invalid_metadata",
    "lifetime with expiry",
  );
  await rejects(
    signOfflineExecutionGrant(proClaims("subscription", null), signingKey, context()),
    "invalid_metadata",
    "subscription without expiry",
  );
  // Forged tokens with the same violations do not verify either.
  await rejects(
    verifyOfflineExecutionGrant(
      await forge(proClaims("lifetime", null, NOW + sevenDays + 1), keyPair.privateKey, KID),
      [publicKey],
      context(),
    ),
    "invalid_metadata",
    "forged lifetime 7d+1s",
  );
  await rejects(
    verifyOfflineExecutionGrant(
      await forge(proClaims("subscription", NOW + 3600, NOW + 3601), keyPair.privateKey, KID),
      [publicKey],
      context(),
    ),
    "invalid_metadata",
    "forged lease past entitlement",
  );
  // Boundaries that must be allowed.
  const exact = await signOfflineExecutionGrant(
    proClaims("subscription", NOW + sevenDays, NOW + sevenDays),
    signingKey,
    context(),
  );
  const verifiedExact = await verifyOfflineExecutionGrant(exact, [publicKey], context());
  assert.equal(verifiedExact.claims.exp - verifiedExact.claims.iat, sevenDays);
  const lifetime = await signOfflineExecutionGrant(
    proClaims("lifetime", null),
    signingKey,
    context(),
  );
  await verifyOfflineExecutionGrant(lifetime, [publicKey], context());
});

Deno.test("OL-CR-7: a FREE execution grant has no upper bound on its execution window — 7d+1s and the maximum representable exp (year 9999) both sign and verify", async () => {
  const sevenDays = OFFLINE_PRO_LEASE_MAX_SECONDS;
  const observed: Record<string, string> = {};
  for (
    const [label, exp] of [
      ["7d+1s", NOW + sevenDays + 1],
      ["1y", NOW + 365 * 24 * 3600],
      ["max_unix_seconds", 253_402_300_799],
    ] as const
  ) {
    try {
      const signed = await signOfflineExecutionGrant(
        { ...freeClaims(), exp },
        signingKey,
        context(),
      );
      const verified = await verifyOfflineExecutionGrant(signed, [publicKey], context());
      observed[label] = `signed_and_verified exp-iat=${verified.claims.exp - verified.claims.iat}s`;
    } catch (error) {
      observed[label] = error instanceof OfflineGrantCryptoError ? error.code : String(error);
    }
  }
  for (const label of Object.keys(observed)) {
    assert.equal(
      observed[label],
      "invalid_metadata",
      `free grant ${label}: ${JSON.stringify(observed)}`,
    );
  }
});

// ---- receipt / reconciliation fixtures ------------------------------------

function lineage(output: "mechanics" | "benchmark"): NumericalOutputLineage {
  return {
    pipeline: { version: "adv-pipeline", sha256: HASH },
    definition: { version: `adv-${output}-definition`, sha256: HASH },
    model: RELEASE[output === "mechanics" ? "mechanicsModel" : "benchmarkModel"],
    preprocessing: { version: "adv-preprocessing", sha256: HASH },
    calibration: { version: `adv-${output}-calibration`, sha256: HASH },
    policy: RELEASE.policy,
    dataset: { version: "adv-dataset", sha256: HASH },
    validationReport: { version: `adv-${output}-report`, sha256: HASH },
    supportedDomain: { version: "adv-domain", sha256: HASH },
  };
}

function outcome(): Extract<AnalysisOutcome, { status: "complete" }> {
  return {
    schemaVersion: ANALYSIS_OUTCOME_SCHEMA_VERSION,
    analysisId: "adv-result",
    operationId: "adv-operation",
    ownerId: OWNER,
    captureId: "adv-capture",
    inputSha256: HASH,
    source: "real",
    status: "complete",
    billingDisposition: "joint_verification_required",
    publication: {
      status: "durably_published",
      publicationId: "adv-publication",
      publishedAtIso: "2026-08-29T12:00:00.000Z",
    },
    mechanics: {
      schemaVersion: MECHANICS_OUTPUT_SCHEMA_VERSION,
      scale: "mechanics_0_10",
      status: "validated_score",
      score: 7,
      lineage: lineage("mechanics"),
    },
    benchmark: {
      schemaVersion: TECHNIQUE_BENCHMARK_SCHEMA_VERSION,
      interpretation: TECHNIQUE_BENCHMARK_INTERPRETATION,
      scale: TECHNIQUE_BENCHMARK_SCALE,
      status: "validated_range",
      interval: { lower: 3.5, upper: 4 },
      uncertainty: {
        kind: "calibrated_prediction_interval",
        nominalCoverage: 0.9,
        coverageScope: "marginal",
        calibrationUnit: "player_session",
      },
      lineage: lineage("benchmark"),
    },
  };
}

function eligibility(): IndependentlyVerifiedAnalysisEligibility {
  return {
    schemaVersion: ANALYSIS_ELIGIBILITY_INPUT_SCHEMA_VERSION,
    verificationSource: "independent_release_authority_and_owner_ledger",
    binding: {
      analysisId: "adv-result",
      operationId: "adv-operation",
      ownerId: OWNER,
      captureId: "adv-capture",
      inputSha256: HASH,
      publicationId: "adv-publication",
    },
    publicationState: "both_outputs_durably_published_once",
    creditState: "unconsumed",
    releaseEligibility: {
      status: "eligible",
      mechanics: { lineage: lineage("mechanics") },
      benchmark: {
        lineage: lineage("benchmark"),
        uncertainty: outcome().benchmark.uncertainty,
        maximumIntervalWidth: 1,
        boundaryStep: 0.5,
        supportedIntervals: [{ lower: 3, upper: 4.5 }],
      },
    },
  };
}

function receipt(grantJwsSha256: string, elapsedMs = 60_000, lifecycleSequence = 2) {
  const claims = freeClaims();
  return {
    schemaVersion: OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
    receiptId: "adv-receipt",
    ownerId: OWNER,
    installationKeyId: claims.installationKeyId,
    grantId: claims.jti,
    grantJwsSha256,
    ticket: {
      allocationId: claims.allocation.allocationId,
      generation: 1,
      ticketId: claims.allocation.ticketIds[0]!,
    },
    operationId: "adv-operation",
    resultId: "adv-result",
    fullOutputSha256: HASH,
    billingDisposition: "joint_verification_required" as const,
    lifecycleSequence,
    nativeTime: {
      schemaVersion: OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
      clock: "ios_mach_continuous_time" as const,
      anchorId: "adv-anchor",
      elapsedMs,
    },
    attestation: {
      schemaVersion: OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION,
      format: "apple_app_attest" as const,
      kind: "assertion" as const,
      environment: "production" as const,
      dataBase64Url: "AQIDBA",
      clientDataSha256: HASH,
    },
  };
}

function receiptBinding(
  grantJwsSha256: string,
  serverEpochSeconds = NOW,
  lastAcceptedLifecycleSequence = 1,
): OfflineReceiptBinding {
  const claims = freeClaims();
  return {
    grant: claims,
    grantJwsSha256,
    currentOwnerId: OWNER,
    attestationEnvironment: "production",
    clientDataSha256: HASH,
    lastAcceptedLifecycleSequence,
    timeAnchor: {
      schemaVersion: OFFLINE_TIME_ANCHOR_SCHEMA_VERSION,
      anchorId: "adv-anchor",
      ownerId: OWNER,
      installationKeyId: claims.installationKeyId,
      grantId: claims.jti,
      serverEpochSeconds,
    },
  };
}

function resultBinding(): OfflineResultBinding {
  return { outcome: outcome(), fullOutputSha256: HASH, analysisEligibility: eligibility() };
}

Deno.test("OL-CR-5: receipt anchor rollback, elapsed time past exp, replayed lifecycle sequence, and a malleated-envelope digest are all refused; the honest receipt binds", async () => {
  const verified = await verifyOfflineExecutionGrant(valid, [publicKey], context());
  const digest = verified.grantJwsSha256;
  const claims = freeClaims();
  const ok = validateOfflineResultReceiptBinding(
    receipt(digest),
    receiptBinding(digest),
    resultBinding(),
  );
  assert.equal(ok.ok, true, JSON.stringify(ok));

  // Trusted anchor issued 1s before the grant existed.
  const rolledBack = validateOfflineResultReceiptBinding(
    receipt(digest),
    receiptBinding(digest, claims.iat - 1),
    resultBinding(),
  );
  assert.equal(rolledBack.ok, false, "anchor before iat accepted");

  // Anchor at exp-1 plus 1000ms elapsed lands exactly on exp (exclusive).
  const atExp = validateOfflineResultReceiptBinding(
    receipt(digest, 1000),
    receiptBinding(digest, claims.exp - 1),
    resultBinding(),
  );
  assert.equal(atExp.ok, false, "execution at exp accepted");
  const lastMs = validateOfflineResultReceiptBinding(
    receipt(digest, 999),
    receiptBinding(digest, claims.exp - 1),
    resultBinding(),
  );
  assert.equal(lastMs.ok, true, JSON.stringify(lastMs));

  // Non-monotonic native clock (elapsed negative / fractional / huge).
  for (const elapsed of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    const bad = validateOfflineResultReceiptBinding(
      receipt(digest, elapsed),
      receiptBinding(digest),
      resultBinding(),
    );
    assert.equal(bad.ok, false, `elapsedMs ${elapsed} accepted`);
  }

  // Replayed / rewound lifecycle sequence.
  for (const [seq, last] of [[1, 1], [0, 1], [2, 2], [5, 7]] as const) {
    const replay = validateOfflineResultReceiptBinding(
      receipt(digest, 60_000, seq),
      receiptBinding(digest, NOW, last),
      resultBinding(),
    );
    assert.equal(replay.ok, false, `lifecycleSequence ${seq} after ${last} accepted`);
  }

  // Receipt bound to the high-S twin's digest of the same grant.
  const twinDigest = await digestOfflineGrantTransport(highSTwin(valid));
  const twinReceipt = validateOfflineResultReceiptBinding(
    receipt(twinDigest),
    receiptBinding(digest),
    resultBinding(),
  );
  assert.equal(twinReceipt.ok, false, "receipt over malleated envelope digest accepted");

  // Account switch: the receipt owner is not the current owner.
  const switched = validateOfflineResultReceiptBinding(
    receipt(digest),
    { ...receiptBinding(digest), currentOwnerId: OTHER_OWNER },
    resultBinding(),
  );
  assert.equal(switched.ok, false, "foreign-owner receipt accepted");
});

Deno.test("OL-CR-6: reconciliation with conflicting server state — every status/disposition pairing the server could be talked into is refused except the contract's own", () => {
  const base = {
    schemaVersion: OFFLINE_RECONCILIATION_SCHEMA_VERSION,
    ownerId: OWNER,
    receiptId: "adv-receipt",
  };
  const chargeable = receipt(HASH);
  const partial = { ...receipt(HASH), billingDisposition: "not_chargeable" as const };
  const accept = (
    extra: Record<string, unknown>,
    original: unknown = chargeable,
  ) => validateOfflineReconciliationStatus({ ...base, ...extra }, original).ok;

  // Contract-conformant answers for a ticketed, chargeable result receipt.
  assert.equal(accept({ status: "pending", financialDisposition: "reserved" }), true);
  assert.equal(
    accept({ status: "result_recorded", resultId: "adv-result", financialDisposition: "consumed" }),
    true,
  );
  assert.equal(
    accept({
      status: "reconciliation_required",
      reasonCode: "conflicting_receipt",
      financialDisposition: "reserved",
    }),
    true,
  );
  // A partial (not chargeable) result is recorded but stays reserved.
  assert.equal(
    accept(
      { status: "result_recorded", resultId: "adv-result", financialDisposition: "reserved" },
      partial,
    ),
    true,
  );

  // Conflicting server state the client must never accept.
  const conflicts: Array<[Record<string, unknown>, unknown, string]> = [
    [
      { status: "pending", financialDisposition: "consumed" },
      chargeable,
      "pending already charged",
    ],
    [
      { status: "pending", financialDisposition: "returned" },
      chargeable,
      "pending already returned",
    ],
    [
      { status: "pending", financialDisposition: "not_applicable" },
      chargeable,
      "pending ticketed receipt declared not_applicable",
    ],
    [
      { status: "result_recorded", resultId: "adv-result", financialDisposition: "reserved" },
      chargeable,
      "delivered joint result left reserved (double-spend window)",
    ],
    [
      { status: "result_recorded", resultId: "adv-result", financialDisposition: "returned" },
      chargeable,
      "delivered result that gave the ticket back",
    ],
    [
      { status: "result_recorded", resultId: "adv-result", financialDisposition: "consumed" },
      partial,
      "partial result charged",
    ],
    [
      { status: "result_recorded", resultId: "adv-other-result", financialDisposition: "consumed" },
      chargeable,
      "server recorded a different result id",
    ],
    [
      { status: "result_recorded", financialDisposition: "consumed" },
      chargeable,
      "recorded without naming the result",
    ],
    [
      { status: "unused_ticket_returned", financialDisposition: "returned" },
      chargeable,
      "result receipt reconciled as an unused ticket",
    ],
    [
      {
        status: "reconciliation_required",
        reasonCode: "conflicting_receipt",
        financialDisposition: "consumed",
      },
      chargeable,
      "ambiguous evidence charged",
    ],
    [
      { status: "reconciliation_required", reasonCode: "refund", financialDisposition: "reserved" },
      chargeable,
      "reason outside the vocabulary",
    ],
    [
      {
        status: "support_review_required",
        reasonCode: "original_installation_lost",
        financialDisposition: "consumed",
      },
      chargeable,
      "support review charged",
    ],
    [
      { status: "refunded", financialDisposition: "returned" },
      chargeable,
      "status outside the vocabulary",
    ],
    [
      { status: "pending", financialDisposition: "reserved", note: "x" },
      chargeable,
      "extra field smuggled",
    ],
    [
      { status: "pending", financialDisposition: "reserved", ownerId: OTHER_OWNER },
      chargeable,
      "server answers for another account",
    ],
    [
      { status: "pending", financialDisposition: "reserved", receiptId: "adv-other-receipt" },
      chargeable,
      "server answers for another receipt",
    ],
    [
      { status: "pending", financialDisposition: "reserved" },
      { ...chargeable, ticket: null },
      "ticketless receipt (Pro) claims a reservation",
    ],
  ];
  for (const [extra, original, label] of conflicts) {
    assert.equal(accept(extra, original), false, label);
  }
});
