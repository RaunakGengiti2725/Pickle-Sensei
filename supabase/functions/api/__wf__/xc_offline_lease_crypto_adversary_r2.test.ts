/**
 * INT-offline-lease adversary (round 2) — crypto / validator attacks on the
 * offline execution-grant envelope and the reconciliation contract at
 * integration head 2994371e1c5edf9a1e9bb12f6c6e4751e3fb4ea1.
 *
 * Pure WebCrypto + the shipped validators; no network, no Postgres.
 *
 *   cd supabase/functions/api && deno test --no-prompt --frozen --lock=deno.lock \
 *     __wf__/xc_offline_lease_crypto_adversary_r2.test.ts
 *
 * A FAILING test is a reproduced break; a passing test is evidence the
 * boundary holds. Attacks:
 *   OL2-CR-1  ECDSA malleability: the high-S twin (s' = n - s) of a valid
 *             grant signature must be refused — otherwise one issued grant
 *             has two verifying compact JWS forms and two grantJwsSha256
 *             values, and every digest-keyed receipt/replay binding forks.
 *   OL2-CR-2  free execution grants: exp - iat has NO upper bound (7d+1s,
 *             one year, year 9999 all sign and verify) although the Pro lease
 *             is capped at 7d and the free ticket's execution window is the
 *             only thing the receipt time anchor can be checked against.
 *   OL2-CR-3  header / algorithm confusion: alg=none, HS256 with the public
 *             JWK bytes as the MAC key, an extra `crit`/`b64`/`jku` header
 *             member, a kid naming ANOTHER loaded key, and a kid known only
 *             to the token are all refused with a typed code.
 *   OL2-CR-4  key rotation fails closed: a grant under a RETIRED kid is
 *             refused once the kid leaves allowedKeyIds even if the key is
 *             still loaded; a loaded key OUTSIDE the allowlist poisons the
 *             whole set (fail closed, not silently ignored); duplicate kids
 *             and an empty set refuse; the rotated grant verifies.
 *   OL2-CR-5  clock rollback at verification: now < iat (device clock rolled
 *             back), now == exp, fractional, -0, NaN, a forged future iat —
 *             all invalid_time; iat and exp-1 are the inclusive window.
 *   OL2-CR-6  reconciliation with conflicting server state: a pending
 *             ticketed receipt is only ever 'reserved'; a not_chargeable
 *             result is never 'consumed'; an unused-ticket return cannot
 *             later become result_recorded; a Pro (ticketless) result is
 *             never 'consumed' or 'reserved'; owner/receipt id mismatches
 *             refuse; the matching statuses validate.
 */
import assert from "node:assert/strict";
import {
  base64url,
  type CompactJWSHeaderParameters,
  CompactSign,
  exportJWK,
  generateKeyPair,
} from "jose";
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
  OFFLINE_RECONCILIATION_SCHEMA_VERSION,
  OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
  OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
  OFFLINE_UNUSED_TICKET_RETURN_SCHEMA_VERSION,
  type OfflineExecutionGrantClaims,
  type OfflineSignedExecutionGrant,
  validateOfflineReconciliationStatus,
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

const OWNER = "0b0402aa-1234-4234-8234-123456789abc";
const OTHER_OWNER = "0b0402bb-4321-4321-8321-cba987654321";
const KID = "adv2-offline-grant-key";
const ROTATED_KID = "adv2-offline-grant-key-rotated";
const NOW = 1_788_500_000;
const HASH = "d".repeat(64);
const RELEASE = {
  policy: { version: "adv2-policy-1", sha256: "a".repeat(64) },
  mechanicsModel: { version: "adv2-mechanics-1", sha256: "b".repeat(64) },
  benchmarkModel: { version: "adv2-benchmark-1", sha256: "c".repeat(64) },
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
const publicJwk = await exportJWK(keyPair.publicKey);
const publicKey = await importOfflineGrantVerificationKey(KID, publicJwk);
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
      issuer: "https://adv2-offline.invalid/grants",
      allowedKeyIds: [...allowedKeyIds],
      ownerId: OWNER,
      installationKeyId: "adv2-installation-key",
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
    jti: "adv2-grant-id",
    installationKeyId: context().binding.installationKeyId,
    iat: NOW,
    exp: NOW + OFFLINE_PRO_LEASE_MAX_SECONDS,
    capabilities: ["analyze_joint_output"],
    release: structuredClone(RELEASE),
    entitlementSource: "identity_lifetime_free",
    allocation: {
      schemaVersion: OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
      allocationId: "adv2-allocation-id",
      generation: 1,
      ticketIds: ["adv2-ticket-1", "adv2-ticket-2"],
      budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
      financialExpiry: "reconciliation_only",
    },
  };
}

function transport(compactJws: string): OfflineSignedExecutionGrant {
  return { schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION, compactJws };
}

async function forge(
  payload: unknown,
  key: CryptoKey,
  header: CompactJWSHeaderParameters,
): Promise<OfflineSignedExecutionGrant> {
  return transport(
    await new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader(header)
      .sign(key),
  );
}

function segment(value: unknown): string {
  return base64url.encode(new TextEncoder().encode(JSON.stringify(value)));
}

async function verdict(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ACCEPTED";
  } catch (error) {
    return error instanceof OfflineGrantCryptoError ? error.code : `THREW ${String(error)}`;
  }
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
  const twin = new Uint8Array(64);
  twin.set(raw.slice(0, 32), 0);
  twin.set(bytesFromBigInt(P256_N - bigIntFromBytes(raw.slice(32)), 32), 32);
  return transport(`${h}.${p}.${base64url.encode(twin)}`);
}

const valid = await signOfflineExecutionGrant(freeClaims(), signingKey, context());

Deno.test(
  "OL2-CR-1: the high-S twin of a valid grant signature is refused (one issued grant ⇒ exactly one verifying compact JWS ⇒ one grantJwsSha256)",
  async () => {
    const verified = await verifyOfflineExecutionGrant(valid, [publicKey], context());
    const twin = highSTwin(valid);
    assert.notEqual(twin.compactJws, valid.compactJws);
    assert.notEqual(await digestOfflineGrantTransport(twin), verified.grantJwsSha256);
    assert.equal(highSTwin(twin).compactJws, valid.compactJws, "twin of the twin is the original");
    const observed = await verdict(verifyOfflineExecutionGrant(twin, [publicKey], context()));
    assert.equal(
      observed,
      "invalid_signature",
      `high-S twin verdict ${observed}: one issued grant has two verifying envelopes / digests`,
    );
  },
);

Deno.test(
  "OL2-CR-2: a FREE execution grant's window is bounded like the Pro lease (7d) — 7d+1s, one year and the maximum representable exp must all refuse to sign/verify",
  async () => {
    const observed: Record<string, string> = {};
    for (const [label, exp] of [
      ["7d+1s", NOW + OFFLINE_PRO_LEASE_MAX_SECONDS + 1],
      ["1y", NOW + 365 * 24 * 3600],
      ["max_unix_seconds", 253_402_300_799],
    ] as const) {
      observed[label] = await verdict(
        signOfflineExecutionGrant({ ...freeClaims(), exp }, signingKey, context()).then((signed) =>
          verifyOfflineExecutionGrant(signed, [publicKey], context()),
        ),
      );
    }
    assert.deepEqual(
      observed,
      {
        "7d+1s": "invalid_metadata",
        "1y": "invalid_metadata",
        max_unix_seconds: "invalid_metadata",
      },
      `free grant execution window is unbounded: ${JSON.stringify(observed)}`,
    );
  },
);

Deno.test(
  "OL2-CR-3: header / algorithm confusion — alg=none, HS256 keyed with the public JWK, extra header members, a kid naming another loaded key, a token-only kid — all refused with a typed code",
  async () => {
    const claims = freeClaims();
    const observed: Record<string, string> = {};

    // alg=none with an empty signature segment and with a 64-byte junk one.
    const noneHeader = segment({ alg: "none", typ: OFFLINE_GRANT_JWS_TYPE, kid: KID });
    observed["alg none, empty sig"] = await verdict(
      verifyOfflineExecutionGrant(
        transport(`${noneHeader}.${segment(claims)}.`),
        [publicKey],
        context(),
      ),
    );
    observed["alg none, junk sig"] = await verdict(
      verifyOfflineExecutionGrant(
        transport(`${noneHeader}.${segment(claims)}.${base64url.encode(new Uint8Array(64))}`),
        [publicKey],
        context(),
      ),
    );

    // HS256 keyed with the public JWK's x||y bytes (the classic key-confusion).
    const macKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array([
        ...base64url.decode(String(publicJwk.x)),
        ...base64url.decode(String(publicJwk.y)),
      ]),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const hsHeader = segment({ alg: "HS256", typ: OFFLINE_GRANT_JWS_TYPE, kid: KID });
    const hsInput = `${hsHeader}.${segment(claims)}`;
    const hsSig = new Uint8Array(
      await crypto.subtle.sign("HMAC", macKey, new TextEncoder().encode(hsInput)),
    );
    observed["HS256 with public key bytes"] = await verdict(
      verifyOfflineExecutionGrant(
        transport(`${hsInput}.${base64url.encode(new Uint8Array([...hsSig, ...hsSig]))}`),
        [publicKey],
        context(),
      ),
    );
    // ES256 header swapped in over the HMAC (header tampering after signing).
    const swappedHeader = segment({ alg: "ES256", typ: OFFLINE_GRANT_JWS_TYPE, kid: KID });
    observed["HS256 mac under ES256 header"] = await verdict(
      verifyOfflineExecutionGrant(
        transport(
          `${swappedHeader}.${segment(claims)}.${base64url.encode(
            new Uint8Array([...hsSig, ...hsSig]),
          )}`,
        ),
        [publicKey],
        context(),
      ),
    );

    // Extra protected-header members signed by the real key.
    // crit/b64=false is refused by jose's compact signer, so sign it raw.
    const critHeader = segment({
      alg: "ES256",
      typ: OFFLINE_GRANT_JWS_TYPE,
      kid: KID,
      crit: ["b64"],
      b64: false,
    });
    const critInput = `${critHeader}.${segment(claims)}`;
    const critSig = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keyPair.privateKey,
        new TextEncoder().encode(critInput),
      ),
    );
    observed["extra header crit/b64"] = await verdict(
      verifyOfflineExecutionGrant(
        transport(`${critInput}.${base64url.encode(critSig)}`),
        [publicKey],
        context(),
      ),
    );
    const extras: Array<[string, Partial<CompactJWSHeaderParameters>]> = [
      ["jku", { jku: "https://adv2-offline.invalid/keys" }],
      ["x5u", { x5u: "https://adv2-offline.invalid/cert" }],
      ["cty", { cty: "JWT" }],
    ];
    for (const [label, extra] of extras) {
      observed[`extra header ${label}`] = await verdict(
        forge(claims, keyPair.privateKey, {
          alg: "ES256",
          typ: OFFLINE_GRANT_JWS_TYPE,
          kid: KID,
          ...extra,
        }).then((t) => verifyOfflineExecutionGrant(t, [publicKey], context())),
      );
    }
    // typ missing / wrong.
    observed["typ missing"] = await verdict(
      forge(claims, keyPair.privateKey, { alg: "ES256", kid: KID }).then((t) =>
        verifyOfflineExecutionGrant(t, [publicKey], context()),
      ),
    );
    observed["typ JWT"] = await verdict(
      forge(claims, keyPair.privateKey, { alg: "ES256", typ: "JWT", kid: KID }).then((t) =>
        verifyOfflineExecutionGrant(t, [publicKey], context()),
      ),
    );
    // kid names the OTHER loaded key; kid known only to the token.
    observed["kid of another loaded key"] = await verdict(
      forge(claims, keyPair.privateKey, {
        alg: "ES256",
        typ: OFFLINE_GRANT_JWS_TYPE,
        kid: ROTATED_KID,
      }).then((t) => verifyOfflineExecutionGrant(t, [publicKey, rotatedKey], context())),
    );
    observed["token-only kid"] = await verdict(
      forge(claims, keyPair.privateKey, {
        alg: "ES256",
        typ: OFFLINE_GRANT_JWS_TYPE,
        kid: "adv2-unknown",
      }).then((t) => verifyOfflineExecutionGrant(t, [publicKey], context())),
    );
    // Payload duplicate-key smuggling: JSON with `sub` twice (last wins in
    // JSON.parse) — the decoded claims must still bind to the expected owner.
    const smuggled = JSON.stringify(claims).replace(
      `"sub":"${OWNER}"`,
      `"sub":"${OTHER_OWNER}","sub":"${OWNER}"`,
    );
    const smuggledSig = await new CompactSign(new TextEncoder().encode(smuggled))
      .setProtectedHeader({ alg: "ES256", typ: OFFLINE_GRANT_JWS_TYPE, kid: KID })
      .sign(keyPair.privateKey);
    const smuggledVerified = await verifyOfflineExecutionGrant(
      transport(smuggledSig),
      [publicKey],
      context(),
    ).catch((e: OfflineGrantCryptoError) => e.code);
    observed["duplicate sub key"] =
      typeof smuggledVerified === "string"
        ? smuggledVerified
        : `ACCEPTED sub=${smuggledVerified.claims.sub}`;

    const accepted = Object.entries(observed).filter(
      ([, v]) => v.startsWith("ACCEPTED") || v.startsWith("THREW"),
    );
    // Duplicate-key JSON is accepted by every JSON parser with last-wins; the
    // bound owner must be the expected one, which is not a break.
    const breaks = accepted.filter(
      ([k, v]) => !(k === "duplicate sub key" && v === `ACCEPTED sub=${OWNER}`),
    );
    assert.deepEqual(breaks, [], JSON.stringify(observed, null, 1));
  },
);

Deno.test(
  "OL2-CR-4: key rotation fails closed — retired kid refused once outside allowedKeyIds even while loaded; a loaded key outside the allowlist poisons the set; duplicate kids / empty set refuse; the rotated grant verifies",
  async () => {
    const rotated = await signOfflineExecutionGrant(freeClaims(), rotatedSigningKey, context());
    const onlyRotated = context({}, [ROTATED_KID]);
    const observed: Record<string, string> = {
      "old grant, old key loaded, allowlist=[rotated]": await verdict(
        verifyOfflineExecutionGrant(valid, [publicKey, rotatedKey], onlyRotated),
      ),
      "rotated grant, key set includes retired key, allowlist=[rotated]": await verdict(
        verifyOfflineExecutionGrant(rotated, [publicKey, rotatedKey], onlyRotated),
      ),
      "rotated grant, key set=[rotated], allowlist=[rotated]": await verdict(
        verifyOfflineExecutionGrant(rotated, [rotatedKey], onlyRotated),
      ),
      "old grant, key set=[rotated]": await verdict(
        verifyOfflineExecutionGrant(valid, [rotatedKey], context()),
      ),
      "duplicate kid entries": await verdict(
        verifyOfflineExecutionGrant(valid, [publicKey, publicKey], context()),
      ),
      "same kid, different key material": await verdict(
        verifyOfflineExecutionGrant(
          valid,
          [await importOfflineGrantVerificationKey(KID, await exportJWK(rotatedPair.publicKey))],
          context(),
        ),
      ),
      "empty key set": await verdict(verifyOfflineExecutionGrant(valid, [], context())),
      "signing key object presented for verification": await verdict(
        verifyOfflineExecutionGrant(valid, [signingKey], context()),
      ),
      "private JWK imported as verification key": await verdict(
        importOfflineGrantVerificationKey(KID, await exportJWK(keyPair.privateKey)),
      ),
    };
    assert.deepEqual(observed, {
      "old grant, old key loaded, allowlist=[rotated]": "invalid_metadata",
      "rotated grant, key set includes retired key, allowlist=[rotated]": "invalid_key",
      "rotated grant, key set=[rotated], allowlist=[rotated]": "ACCEPTED",
      "old grant, key set=[rotated]": "invalid_key",
      "duplicate kid entries": "invalid_key",
      "same kid, different key material": "invalid_signature",
      "empty key set": "invalid_key",
      "signing key object presented for verification": "invalid_key",
      "private JWK imported as verification key": "invalid_key",
    });
  },
);

Deno.test(
  "OL2-CR-5: clock rollback at verification — now < iat (rolled-back device clock), now == exp, fractional, -0, NaN and a forged future iat are invalid_time; iat and exp-1 verify",
  async () => {
    const claims = freeClaims();
    const observed: Record<string, string> = {};
    for (const [label, now] of [
      ["1s before iat", claims.iat - 1],
      ["30d before iat (rolled back)", claims.iat - 30 * 24 * 3600],
      ["exactly exp", claims.exp],
      ["fractional", claims.iat + 0.5],
      ["negative zero", -0],
      ["NaN", Number.NaN],
      ["unsafe integer", 2 ** 53],
    ] as const) {
      observed[label] = await verdict(
        verifyOfflineExecutionGrant(valid, [publicKey], context({ nowEpochSeconds: now })),
      );
    }
    observed["at iat"] = await verdict(
      verifyOfflineExecutionGrant(valid, [publicKey], context({ nowEpochSeconds: claims.iat })),
    );
    observed["at exp-1"] = await verdict(
      verifyOfflineExecutionGrant(valid, [publicKey], context({ nowEpochSeconds: claims.exp - 1 })),
    );
    observed["forged iat in the future"] = await verdict(
      forge({ ...claims, iat: NOW + 60, exp: NOW + 3600 }, keyPair.privateKey, {
        alg: "ES256",
        typ: OFFLINE_GRANT_JWS_TYPE,
        kid: KID,
      }).then((t) => verifyOfflineExecutionGrant(t, [publicKey], context())),
    );
    observed["mint with rolled-back server clock (now < iat)"] = await verdict(
      signOfflineExecutionGrant(claims, signingKey, context({ nowEpochSeconds: claims.iat - 1 })),
    );
    observed["mint already expired"] = await verdict(
      signOfflineExecutionGrant(claims, signingKey, context({ nowEpochSeconds: claims.exp })),
    );
    assert.deepEqual(observed, {
      "1s before iat": "invalid_time",
      "30d before iat (rolled back)": "invalid_time",
      "exactly exp": "invalid_time",
      fractional: "invalid_time",
      "negative zero": "invalid_time",
      NaN: "invalid_time",
      "unsafe integer": "invalid_time",
      "at iat": "ACCEPTED",
      "at exp-1": "ACCEPTED",
      "forged iat in the future": "invalid_time",
      "mint with rolled-back server clock (now < iat)": "invalid_time",
      "mint already expired": "invalid_time",
    });
  },
);

function resultReceipt(
  billingDisposition: "joint_verification_required" | "not_chargeable",
  ticket: boolean,
) {
  return {
    schemaVersion: OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
    receiptId: "adv2-receipt",
    ownerId: OWNER,
    installationKeyId: "adv2-installation-key",
    grantId: "adv2-grant-id",
    grantJwsSha256: HASH,
    ticket: ticket
      ? { allocationId: "adv2-allocation-id", generation: 1, ticketId: "adv2-ticket-1" }
      : null,
    operationId: "adv2-operation",
    resultId: "adv2-result",
    fullOutputSha256: HASH,
    billingDisposition,
    lifecycleSequence: 2,
    nativeTime: {
      schemaVersion: OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
      clock: "ios_mach_continuous_time",
      anchorId: "adv2-anchor",
      elapsedMs: 60_000,
    },
    attestation: {
      schemaVersion: OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION,
      format: "apple_app_attest",
      kind: "assertion",
      environment: "production",
      dataBase64Url: "AQIDBA",
      clientDataSha256: HASH,
    },
  };
}

function unusedReturn() {
  const {
    operationId: _o,
    resultId: _r,
    fullOutputSha256: _f,
    billingDisposition: _b,
    ...base
  } = resultReceipt("not_chargeable", true);
  return {
    ...base,
    schemaVersion: OFFLINE_UNUSED_TICKET_RETURN_SCHEMA_VERSION,
    terminalState: "returned",
  };
}

function status(fields: Record<string, unknown>) {
  return {
    schemaVersion: OFFLINE_RECONCILIATION_SCHEMA_VERSION,
    ownerId: OWNER,
    receiptId: "adv2-receipt",
    ...fields,
  };
}

Deno.test(
  "OL2-CR-6: reconciliation with conflicting server state — pending ticket is only 'reserved'; not_chargeable never 'consumed'; a returned ticket never becomes a result; Pro results are never consumed/reserved; owner/receipt mismatch refuses",
  () => {
    const chargeable = resultReceipt("joint_verification_required", true);
    const notChargeable = resultReceipt("not_chargeable", true);
    const pro = resultReceipt("joint_verification_required", false);
    const returned = unusedReturn();
    const cases: Array<[string, unknown, unknown, boolean]> = [
      [
        "pending ticketed ⇒ reserved",
        status({ status: "pending", financialDisposition: "reserved" }),
        chargeable,
        true,
      ],
      [
        "pending ticketed ⇒ consumed",
        status({ status: "pending", financialDisposition: "consumed" }),
        chargeable,
        false,
      ],
      [
        "pending ticketed ⇒ returned",
        status({ status: "pending", financialDisposition: "returned" }),
        chargeable,
        false,
      ],
      [
        "pending ticketed ⇒ not_applicable",
        status({ status: "pending", financialDisposition: "not_applicable" }),
        chargeable,
        false,
      ],
      [
        "chargeable result ⇒ consumed",
        status({
          status: "result_recorded",
          resultId: "adv2-result",
          financialDisposition: "consumed",
        }),
        chargeable,
        true,
      ],
      [
        "chargeable result ⇒ reserved",
        status({
          status: "result_recorded",
          resultId: "adv2-result",
          financialDisposition: "reserved",
        }),
        chargeable,
        false,
      ],
      [
        "chargeable result, other resultId",
        status({
          status: "result_recorded",
          resultId: "adv2-other",
          financialDisposition: "consumed",
        }),
        chargeable,
        false,
      ],
      [
        "not_chargeable result ⇒ consumed",
        status({
          status: "result_recorded",
          resultId: "adv2-result",
          financialDisposition: "consumed",
        }),
        notChargeable,
        false,
      ],
      [
        "not_chargeable result ⇒ reserved",
        status({
          status: "result_recorded",
          resultId: "adv2-result",
          financialDisposition: "reserved",
        }),
        notChargeable,
        true,
      ],
      [
        "not_chargeable result ⇒ returned",
        status({
          status: "result_recorded",
          resultId: "adv2-result",
          financialDisposition: "returned",
        }),
        notChargeable,
        false,
      ],
      [
        "Pro result ⇒ consumed",
        status({
          status: "result_recorded",
          resultId: "adv2-result",
          financialDisposition: "consumed",
        }),
        pro,
        false,
      ],
      [
        "Pro result ⇒ reserved",
        status({
          status: "result_recorded",
          resultId: "adv2-result",
          financialDisposition: "reserved",
        }),
        pro,
        false,
      ],
      [
        "Pro result ⇒ not_applicable",
        status({
          status: "result_recorded",
          resultId: "adv2-result",
          financialDisposition: "not_applicable",
        }),
        pro,
        true,
      ],
      [
        "Pro pending ⇒ reserved",
        status({ status: "pending", financialDisposition: "reserved" }),
        pro,
        false,
      ],
      [
        "returned ticket ⇒ returned",
        status({ status: "unused_ticket_returned", financialDisposition: "returned" }),
        returned,
        true,
      ],
      [
        "returned ticket ⇒ result_recorded",
        status({
          status: "result_recorded",
          resultId: "adv2-result",
          financialDisposition: "consumed",
        }),
        returned,
        false,
      ],
      [
        "result receipt ⇒ unused_ticket_returned",
        status({ status: "unused_ticket_returned", financialDisposition: "returned" }),
        chargeable,
        false,
      ],
      [
        "returned ticket ⇒ pending reserved",
        status({ status: "pending", financialDisposition: "reserved" }),
        returned,
        true,
      ],
      [
        "reconciliation_required ticketed ⇒ reserved",
        status({
          status: "reconciliation_required",
          reasonCode: "conflicting_receipt",
          financialDisposition: "reserved",
        }),
        chargeable,
        true,
      ],
      [
        "reconciliation_required ticketed ⇒ consumed",
        status({
          status: "reconciliation_required",
          reasonCode: "conflicting_receipt",
          financialDisposition: "consumed",
        }),
        chargeable,
        false,
      ],
      [
        "reconciliation_required unknown reason",
        status({
          status: "reconciliation_required",
          reasonCode: "timeout_refund",
          financialDisposition: "reserved",
        }),
        chargeable,
        false,
      ],
      [
        "support_review ⇒ reserved",
        status({
          status: "support_review_required",
          reasonCode: "original_installation_lost",
          financialDisposition: "reserved",
        }),
        chargeable,
        true,
      ],
      [
        "support_review ⇒ returned",
        status({
          status: "support_review_required",
          reasonCode: "original_installation_lost",
          financialDisposition: "returned",
        }),
        chargeable,
        false,
      ],
      [
        "owner mismatch",
        {
          ...status({ status: "pending", financialDisposition: "reserved" }),
          ownerId: OTHER_OWNER,
        },
        chargeable,
        false,
      ],
      [
        "receipt id mismatch",
        {
          ...status({ status: "pending", financialDisposition: "reserved" }),
          receiptId: "adv2-other",
        },
        chargeable,
        false,
      ],
      [
        "extra field",
        status({ status: "pending", financialDisposition: "reserved", refunded: true }),
        chargeable,
        false,
      ],
      [
        "status with no receipt",
        status({ status: "pending", financialDisposition: "reserved" }),
        null,
        false,
      ],
    ];
    const wrong = cases
      .map(([label, raw, receipt, expected]) => {
        const result = validateOfflineReconciliationStatus(raw, receipt);
        return result.ok === expected
          ? null
          : `${label}: expected ok=${expected}, got ${JSON.stringify(result)}`;
      })
      .filter((line): line is string => line !== null);
    assert.deepEqual(wrong, []);
  },
);
