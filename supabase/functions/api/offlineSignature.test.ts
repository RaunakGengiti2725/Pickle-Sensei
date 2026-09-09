import assert from "node:assert/strict";
import {
  base64url,
  CompactSign,
  exportJWK,
  generateKeyPair,
  generateSecret,
  jwtVerify,
  SignJWT,
  type CompactJWSHeaderParameters,
  type JWTPayload,
} from "jose";
import {
  OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
  OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
  OFFLINE_FREE_ALLOCATION_POLICY,
  OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
  OFFLINE_GRANT_AUDIENCE,
  OFFLINE_GRANT_JWS_TYPE,
  OFFLINE_JWS_REQUIREMENTS,
  OFFLINE_PRO_LEASE_MAX_SECONDS,
  OFFLINE_PRO_LEASE_SCHEMA_VERSION,
  OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
  validateOfflineExecutionGrantMetadata,
  type OfflineExecutionGrantClaims,
  type OfflineSignedExecutionGrant,
} from "../../../packages/shared-types/src/offlineAuthorization.ts";
import { digestOfflineGrantTransport } from "./canonicalDigest.ts";
import {
  OFFLINE_GRANT_KEY_RING_SCHEMA_VERSION,
  OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS,
  OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS,
  OFFLINE_SIGNATURE_TRUST_BOUNDARY,
  OfflineGrantCryptoError,
  importOfflineGrantKeyRing,
  importOfflineGrantVerificationKey,
  signOfflineExecutionGrant,
  verifyOfflineExecutionGrant,
  type OfflineGrantKey,
  type OfflineGrantVerificationContext,
} from "./offlineSignature.ts";

const OWNER = "12345678-1234-4234-8234-123456789abc";
const OTHER_OWNER = "87654321-4321-4321-8321-cba987654321";
const KID = "ephemeral-offline-grant-key";
const ROTATED_KID = "ephemeral-offline-grant-key-rotated";
const NOW = 1_788_000_000;
const RELEASE = {
  policy: { version: "test-only-policy-1", sha256: "a".repeat(64) },
  mechanicsModel: { version: "test-only-mechanics-1", sha256: "b".repeat(64) },
  benchmarkModel: { version: "test-only-benchmark-1", sha256: "c".repeat(64) },
};
const keyPair = await generateKeyPair("ES256", { extractable: true });
const rotatedPair = await generateKeyPair("ES256", { extractable: true });
const signingKey: OfflineGrantKey = {
  purpose: OFFLINE_JWS_REQUIREMENTS.keyPurpose,
  kid: KID,
  key: keyPair.privateKey,
};
const publicJwk = await exportJWK(keyPair.publicKey);
const publicKey = await importOfflineGrantVerificationKey(KID, publicJwk);
const rotatedKey = await importOfflineGrantVerificationKey(
  ROTATED_KID,
  await exportJWK(rotatedPair.publicKey),
);

function context(): OfflineGrantVerificationContext {
  return {
    binding: {
      issuer: "https://offline-crypto-test.invalid/grants",
      allowedKeyIds: [KID],
      ownerId: OWNER,
      installationKeyId: "test-installation-key",
    },
    release: structuredClone(RELEASE),
    nowEpochSeconds: NOW,
  };
}

function baseClaims() {
  return {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: context().binding.issuer,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: OWNER,
    jti: "test-only-grant-id",
    installationKeyId: context().binding.installationKeyId,
    iat: NOW,
    exp: NOW + OFFLINE_PRO_LEASE_MAX_SECONDS,
    capabilities: ["analyze_joint_output"] as const,
    release: structuredClone(RELEASE),
  };
}

function freeClaims(): Extract<
  OfflineExecutionGrantClaims,
  { entitlementSource: "identity_lifetime_free" }
> {
  return {
    ...baseClaims(),
    entitlementSource: "identity_lifetime_free",
    allocation: {
      schemaVersion: OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
      allocationId: "test-only-allocation-id",
      generation: 1,
      ticketIds: ["test-only-ticket-1", "test-only-ticket-2"],
      budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
      financialExpiry: "reconciliation_only",
    },
  };
}

function proClaims(
  kind: "subscription" | "lifetime" = "subscription",
): Extract<OfflineExecutionGrantClaims, { entitlementSource: "verified_store" }> {
  return {
    ...baseClaims(),
    entitlementSource: "verified_store",
    lease:
      kind === "subscription"
        ? {
            schemaVersion: OFFLINE_PRO_LEASE_SCHEMA_VERSION,
            kind,
            verifiedEntitlementExpiresAt: NOW + OFFLINE_PRO_LEASE_MAX_SECONDS,
          }
        : {
            schemaVersion: OFFLINE_PRO_LEASE_SCHEMA_VERSION,
            kind,
            verifiedEntitlementExpiresAt: null,
          },
  };
}

function protectedHeader(): CompactJWSHeaderParameters {
  return { alg: "ES256", typ: OFFLINE_GRANT_JWS_TYPE, kid: KID };
}

function transport(compactJws: string): OfflineSignedExecutionGrant {
  return { schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION, compactJws };
}

async function libraryToken(
  payload: unknown,
  header = protectedHeader(),
): Promise<OfflineSignedExecutionGrant> {
  return transport(
    await new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader(header)
      .sign(keyPair.privateKey, { crit: { test_extension: true } }),
  );
}

const valid = await signOfflineExecutionGrant(freeClaims(), signingKey, context());

function tamperedSegment(index: number, segment: string): OfflineSignedExecutionGrant {
  const segments = valid.compactJws.split(".");
  segments[index] = segment;
  return transport(segments.join("."));
}

async function rejectGrant(
  raw: unknown,
  code: OfflineGrantCryptoError["code"],
  expected = context(),
  keys: readonly OfflineGrantKey[] = [publicKey],
): Promise<void> {
  await assert.rejects(verifyOfflineExecutionGrant(raw, keys, expected), {
    name: "OfflineGrantCryptoError",
    code,
  });
}

Deno.test(
  "ES256 compact JWT roundtrip uses ephemeral keys and the shared strict claims contract",
  async () => {
    const verified = await verifyOfflineExecutionGrant(valid, [publicKey], context());
    assert.deepEqual(verified.claims, freeClaims());
    assert.deepEqual(verified.protectedHeader, protectedHeader());
    assert.equal(verified.transport.compactJws, valid.compactJws);
    assert.equal(verified.grantJwsSha256, await digestOfflineGrantTransport(valid));
    assert.equal(base64url.decode(valid.compactJws.split(".")[2]).byteLength, 64);
    assert.equal(
      validateOfflineExecutionGrantMetadata(
        verified.protectedHeader,
        verified.claims,
        context().binding,
      ).ok,
      true,
    );
    assert.equal(verified.verification, "signature_and_bindings_only");
    for (const value of [
      verified,
      verified.transport,
      verified.protectedHeader,
      verified.claims,
      verified.claims.release,
      verified.claims.release.policy,
      verified.claims.capabilities,
    ])
      assert.equal(Object.isFrozen(value), true);
  },
);

Deno.test(
  "standard jose SignJWT and jwtVerify interoperate without a custom signature encoding",
  async () => {
    const joseVerified = await jwtVerify(valid.compactJws, keyPair.publicKey, {
      algorithms: ["ES256"],
      issuer: context().binding.issuer,
      audience: OFFLINE_GRANT_AUDIENCE,
      subject: OWNER,
      typ: OFFLINE_GRANT_JWS_TYPE,
      currentDate: new Date(NOW * 1000),
      clockTolerance: 0,
    });
    assert.deepEqual(joseVerified.payload, freeClaims());
    const signed = await new SignJWT(freeClaims() as unknown as JWTPayload)
      .setProtectedHeader(protectedHeader())
      .sign(keyPair.privateKey);
    assert.deepEqual(
      (await verifyOfflineExecutionGrant(transport(signed), [publicKey], context())).claims,
      freeClaims(),
    );
  },
);

Deno.test(
  "valid JWT JSON whitespace and member order are accepted but exact compact bytes determine the digest",
  async () => {
    const reversed = Object.fromEntries(Object.entries(freeClaims()).reverse());
    const compact = await new CompactSign(
      new TextEncoder().encode(JSON.stringify(reversed, null, 2)),
    )
      .setProtectedHeader(protectedHeader())
      .sign(keyPair.privateKey);
    const verified = await verifyOfflineExecutionGrant(transport(compact), [publicKey], context());
    assert.deepEqual(verified.claims, freeClaims());
    assert.notEqual(verified.grantJwsSha256, await digestOfflineGrantTransport(valid));
  },
);

Deno.test("configured key rotation requires the exact purpose and kid allowlist", async () => {
  const expected = context();
  const rotatedContext = {
    ...expected,
    binding: { ...expected.binding, allowedKeyIds: [KID, ROTATED_KID] },
  };
  const signed = await signOfflineExecutionGrant(
    freeClaims(),
    { ...signingKey, kid: ROTATED_KID, key: rotatedPair.privateKey },
    rotatedContext,
  );
  assert.equal(
    (await verifyOfflineExecutionGrant(signed, [publicKey, rotatedKey], rotatedContext))
      .protectedHeader.kid,
    ROTATED_KID,
  );
  await rejectGrant(signed, "invalid_metadata");
  await rejectGrant(signed, "invalid_key", rotatedContext, [publicKey]);
});

const HEADER_INJECTIONS: readonly (readonly [string, Record<string, unknown>])[] = [
  ["jku", { jku: "https://attacker.invalid/keys.json" }],
  ["x5u", { x5u: "https://attacker.invalid/certificate.pem" }],
  ["embedded jwk", { jwk: publicJwk }],
  ["certificate chain", { x5c: ["not-a-certificate"] }],
  ["certificate thumbprint", { x5t: "not-a-thumbprint" }],
  ["content type", { cty: "JWT" }],
  ["unneeded b64", { b64: true }],
  ["critical extension", { crit: ["test_extension"], test_extension: true }],
  ["unknown property", { grantPermissions: true }],
];
for (const [name, additions] of HEADER_INJECTIONS) {
  Deno.test(
    `signed header rejects ${name} injection without fetching any key material`,
    async () => {
      await rejectGrant(
        await libraryToken(freeClaims(), { ...protectedHeader(), ...additions }),
        "invalid_metadata",
      );
    },
  );
}

for (const [name, header] of [
  ["algorithm none", { ...protectedHeader(), alg: "none" }],
  ["algorithm HS256", { ...protectedHeader(), alg: "HS256" }],
  ["algorithm ES384", { ...protectedHeader(), alg: "ES384" }],
  ["algorithm lowercase", { ...protectedHeader(), alg: "es256" }],
  ["type JWT", { ...protectedHeader(), typ: "JWT" }],
  ["type case alias", { ...protectedHeader(), typ: OFFLINE_GRANT_JWS_TYPE.toUpperCase() }],
  [
    "type application alias",
    { ...protectedHeader(), typ: `application/${OFFLINE_GRANT_JWS_TYPE}` },
  ],
  ["missing type", { alg: "ES256", kid: KID }],
  ["missing kid", { alg: "ES256", typ: OFFLINE_GRANT_JWS_TYPE }],
  ["unknown kid", { ...protectedHeader(), kid: "unknown-key" }],
  ["oversized kid", { ...protectedHeader(), kid: "k".repeat(129) }],
  ["empty critical list", { ...protectedHeader(), crit: [] }],
  ["critical null", { ...protectedHeader(), crit: null }],
  ["prototype member", { ...protectedHeader(), ["__proto__"]: { alg: "none" } }],
] as const) {
  Deno.test(`exact protected metadata rejects ${name}`, async () => {
    await rejectGrant(
      tamperedSegment(0, base64url.encode(JSON.stringify(header))),
      "invalid_metadata",
    );
  });
}

const INVALID_TRANSPORTS: readonly (readonly [string, unknown])[] = [
  ["null", null],
  ["raw bearer string", valid.compactJws],
  ["array", [valid]],
  ["wrong schema", { ...valid, schemaVersion: "offline-grant-v0" }],
  ["detached claims", { ...valid, claims: freeClaims() }],
  ["nonstring compact", { ...valid, compactJws: 1 }],
  ["oversized transport", { ...valid, compactJws: "a".repeat(16_385) }],
  ["extra segment", transport(`${valid.compactJws}.AA`)],
  ["missing signature", transport(valid.compactJws.split(".").slice(0, 2).join("."))],
  ["empty header", tamperedSegment(0, "")],
  ["empty payload", tamperedSegment(1, "")],
  ["oversized header", tamperedSegment(0, "A".repeat(1028))],
  ["oversized payload", tamperedSegment(1, "A".repeat(15_276))],
  ["short signature", tamperedSegment(2, base64url.encode(new Uint8Array(63)))],
  ["long signature", tamperedSegment(2, base64url.encode(new Uint8Array(65)))],
  ["impossible base64 length", tamperedSegment(0, "A")],
  ["noncanonical header pad bits", tamperedSegment(0, "e31")],
  ["noncanonical payload pad bits", tamperedSegment(1, "e31")],
  ["noncanonical signature pad bits", tamperedSegment(2, `${"A".repeat(85)}B`)],
];
for (const [name, value] of INVALID_TRANSPORTS) {
  Deno.test(`compact transport rejects ${name} before cryptography`, () =>
    rejectGrant(value, "invalid_transport"),
  );
}
for (const index of [0, 1, 2]) {
  for (const suffix of ["=", " ", "\n", "+", "/", "\u00e9"]) {
    Deno.test(
      `compact segment ${index} rejects non-base64url suffix ${JSON.stringify(suffix)}`,
      async () => {
        await rejectGrant(
          tamperedSegment(index, valid.compactJws.split(".")[index] + suffix),
          "invalid_transport",
        );
      },
    );
  }
}

const INVALID_UTF8: readonly (readonly [string, number[]])[] = [
  ["invalid leading byte", [0xff]],
  ["overlong encoding", [0xc0, 0xaf]],
  ["encoded surrogate", [0xed, 0xa0, 0x80]],
  ["out of range code point", [0xf4, 0x90, 0x80, 0x80]],
  ["truncated sequence", [0xe2, 0x82]],
];
for (const [name, bytes] of INVALID_UTF8) {
  Deno.test(
    `fatal UTF-8 decoder rejects ${name} in protected header and signed payload`,
    async () => {
      const payload = new Uint8Array(bytes);
      await rejectGrant(tamperedSegment(0, base64url.encode(payload)), "invalid_transport");
      const compact = await new CompactSign(payload)
        .setProtectedHeader(protectedHeader())
        .sign(keyPair.privateKey);
      await rejectGrant(transport(compact), "invalid_transport");
    },
  );
}

for (const source of [
  "{",
  "{}{}",
  "\ufeff{}",
  String.raw`{"kid":"\ud800"}`,
  String.raw`{"value":1e400}`,
]) {
  Deno.test(
    `compact JSON decoder rejects malformed or non-I-JSON text ${JSON.stringify(source)}`,
    async () => {
      for (const index of [0, 1])
        await rejectGrant(tamperedSegment(index, base64url.encode(source)), "invalid_transport");
    },
  );
}
for (const value of [null, [], "object required", 1]) {
  Deno.test(`compact metadata rejects JSON non-object ${JSON.stringify(value)}`, async () => {
    await rejectGrant(await libraryToken(value), "invalid_metadata");
    await rejectGrant(
      tamperedSegment(0, base64url.encode(JSON.stringify(value))),
      "invalid_metadata",
    );
  });
}

Deno.test("signed payload rejects escaped lone surrogates in model metadata", async () => {
  const claims = {
    ...freeClaims(),
    release: { ...RELEASE, policy: { ...RELEASE.policy, version: "\ud800" } },
  };
  await rejectGrant(await libraryToken(claims), "invalid_transport");
});

Deno.test("bit-flipped and all-zero ES256 signatures cannot verify", async () => {
  const signature = base64url.decode(valid.compactJws.split(".")[2]);
  signature[0] ^= 1;
  await rejectGrant(tamperedSegment(2, base64url.encode(signature)), "invalid_signature");
  await rejectGrant(tamperedSegment(2, base64url.encode(new Uint8Array(64))), "invalid_signature");
});

Deno.test(
  "claim tampering and a different public key fail even when all metadata bindings match",
  async () => {
    await rejectGrant(
      tamperedSegment(
        1,
        base64url.encode(JSON.stringify({ ...freeClaims(), jti: "tampered-grant-id" })),
      ),
      "invalid_signature",
    );
    const wrong = await importOfflineGrantVerificationKey(
      KID,
      await exportJWK(rotatedPair.publicKey),
    );
    await rejectGrant(valid, "invalid_signature", context(), [wrong]);
  },
);

for (const [field, value] of [
  ["issuer", "https://different-issuer.invalid"],
  ["ownerId", OTHER_OWNER],
  ["installationKeyId", "another-installation"],
] as const) {
  Deno.test(`independent ${field} binding cannot be taken from the token`, async () => {
    const expected = context();
    await rejectGrant(valid, "invalid_metadata", {
      ...expected,
      binding: { ...expected.binding, [field]: value },
    });
  });
}

const INVALID_CLAIMS: readonly (readonly [string, Record<string, unknown>])[] = [
  ["issuer", { iss: "https://attacker.invalid" }],
  ["audience", { aud: "api-bearer" }],
  ["audience array alias", { aud: [OFFLINE_GRANT_AUDIENCE] }],
  ["subject", { sub: OTHER_OWNER }],
  ["installation", { installationKeyId: "another-installation" }],
  ["protocol", { protocolVersion: "offline-authorization-v0" }],
  ["schema", { schemaVersion: "offline-execution-grant-v0" }],
  ["extra permission", { premium: true }],
  ["extra capability", { capabilities: ["analyze_joint_output", "premium"] }],
  ["missing capability", { capabilities: [] }],
  ["fractional iat", { iat: NOW + 0.5 }],
  ["fractional exp", { exp: NOW + 1.5 }],
  ["string iat", { iat: String(NOW) }],
  ["zero lifetime", { exp: NOW }],
  ["backwards lifetime", { exp: NOW - 1 }],
  ["invalid grant id", { jti: "" }],
  [
    "duplicated free tickets",
    { allocation: { ...freeClaims().allocation, ticketIds: ["ticket", "ticket"] } },
  ],
  [
    "free timeout refund",
    { allocation: { ...freeClaims().allocation, financialExpiry: "timeout" } },
  ],
  ["free and Pro at once", { lease: proClaims().lease }],
];
for (const [name, changes] of INVALID_CLAIMS) {
  Deno.test(
    `shared validator rejects genuinely signed invalid claim ${name} on verification and issuance`,
    async () => {
      const claims = { ...freeClaims(), ...changes };
      await rejectGrant(await libraryToken(claims), "invalid_metadata");
      await assert.rejects(
        signOfflineExecutionGrant(claims as OfflineExecutionGrantClaims, signingKey, context()),
        { code: "invalid_metadata" },
      );
    },
  );
}

for (const artifact of ["policy", "mechanicsModel", "benchmarkModel"] as const) {
  for (const field of ["version", "sha256"] as const) {
    Deno.test(`independent release binding checks ${artifact}.${field}`, async () => {
      const different = {
        ...RELEASE,
        [artifact]: {
          ...RELEASE[artifact],
          [field]: field === "version" ? "another-version" : "f".repeat(64),
        },
      };
      await rejectGrant(valid, "invalid_release_binding", { ...context(), release: different });
      const claims = { ...freeClaims(), release: different };
      await rejectGrant(await libraryToken(claims), "invalid_release_binding");
      await assert.rejects(signOfflineExecutionGrant(claims, signingKey, context()), {
        code: "invalid_release_binding",
      });
    });
  }
}

for (const now of [NOW, NOW + OFFLINE_PRO_LEASE_MAX_SECONDS - 1]) {
  Deno.test(
    `grant integer-second validity includes ${now} inside iat-inclusive exp-exclusive bounds`,
    async () => {
      await verifyOfflineExecutionGrant(valid, [publicKey], { ...context(), nowEpochSeconds: now });
    },
  );
}
const INVALID_NOW: readonly (readonly [string, unknown])[] = [
  ["before iat", NOW - 1],
  ["at exp", NOW + OFFLINE_PRO_LEASE_MAX_SECONDS],
  ["after exp", NOW + OFFLINE_PRO_LEASE_MAX_SECONDS + 1],
  ["fraction", NOW + 0.5],
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["negative Infinity", -Infinity],
  ["negative zero", -0],
  ["string", String(NOW)],
  ["null", null],
  ["missing", undefined],
  ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
];
for (const [name, now] of INVALID_NOW) {
  Deno.test(
    `no clock fallback or tolerance: rejects ${name} on issuance and verification`,
    async () => {
      const expected = { ...context(), nowEpochSeconds: now as number };
      await rejectGrant(valid, "invalid_time", expected);
      await assert.rejects(signOfflineExecutionGrant(freeClaims(), signingKey, expected), {
        code: "invalid_time",
      });
    },
  );
}

for (const kind of ["subscription", "lifetime"] as const) {
  Deno.test(
    `Pro ${kind} lease accepts exactly seven days but never seven days plus one second`,
    async () => {
      const claims = proClaims(kind);
      const signed = await signOfflineExecutionGrant(claims, signingKey, context());
      assert.equal(
        (await verifyOfflineExecutionGrant(signed, [publicKey], context())).claims.exp - NOW,
        604_800,
      );
      await rejectGrant(signed, "invalid_time", { ...context(), nowEpochSeconds: claims.exp });
      const overlong = {
        ...claims,
        exp: claims.exp + 1,
        lease:
          kind === "subscription"
            ? { ...claims.lease, verifiedEntitlementExpiresAt: claims.exp + 10 }
            : claims.lease,
      };
      await rejectGrant(await libraryToken(overlong), "invalid_metadata");
      await assert.rejects(
        signOfflineExecutionGrant(overlong as OfflineExecutionGrantClaims, signingKey, context()),
        { code: "invalid_metadata" },
      );
    },
  );
}

Deno.test(
  "subscription grants cannot outlive verified store expiry even within seven days",
  async () => {
    const short = {
      ...proClaims(),
      exp: NOW + 3600,
      lease: {
        schemaVersion: OFFLINE_PRO_LEASE_SCHEMA_VERSION,
        kind: "subscription" as const,
        verifiedEntitlementExpiresAt: NOW + 3600,
      },
    };
    const signed = await signOfflineExecutionGrant(short, signingKey, context());
    await verifyOfflineExecutionGrant(signed, [publicKey], {
      ...context(),
      nowEpochSeconds: short.exp - 1,
    });
    const overlong = { ...short, exp: short.exp + 1 };
    await rejectGrant(await libraryToken(overlong), "invalid_metadata");
    await assert.rejects(signOfflineExecutionGrant(overlong, signingKey, context()), {
      code: "invalid_metadata",
    });
    for (const expiresAt of [NOW, NOW - 1, null]) {
      await rejectGrant(
        await libraryToken({
          ...short,
          lease: { ...short.lease, verifiedEntitlementExpiresAt: expiresAt },
        }),
        "invalid_metadata",
      );
    }
    await rejectGrant(
      await libraryToken({ ...proClaims("lifetime"), lease: short.lease, exp: NOW + 604_800 }),
      "invalid_metadata",
    );
    await rejectGrant(
      await libraryToken({
        ...proClaims("lifetime"),
        lease: { ...proClaims("lifetime").lease, verifiedEntitlementExpiresAt: NOW + 604_800 },
      }),
      "invalid_metadata",
    );
  },
);

Deno.test(
  "public JWK import accepts only independently configured P-256 verification material",
  async () => {
    const entry = await importOfflineGrantVerificationKey(KID, {
      ...publicJwk,
      kid: KID,
      alg: "ES256",
      use: "sig",
      key_ops: ["verify"],
      ext: true,
    });
    assert.equal(entry.key.type, "public");
    assert.equal(entry.key.extractable, false);
    assert.deepEqual(entry.key.usages, ["verify"]);
    assert.equal(Object.isFrozen(entry), true);
    await verifyOfflineExecutionGrant(valid, [entry], context());
  },
);

const PRIVATE_JWK = await exportJWK(keyPair.privateKey);
const BAD_JWKS: readonly (readonly [string, unknown])[] = [
  ["private JWK", PRIVATE_JWK],
  ["undefined private component", { ...publicJwk, d: undefined }],
  ["null", null],
  ["symmetric key", { kty: "oct", k: "AA" }],
  ["wrong curve", { ...publicJwk, crv: "P-384" }],
  ["wrong key type", { ...publicJwk, kty: "RSA" }],
  ["wrong algorithm", { ...publicJwk, alg: "HS256" }],
  ["encryption use", { ...publicJwk, use: "enc" }],
  ["signing usage", { ...publicJwk, key_ops: ["sign"] }],
  ["empty usage", { ...publicJwk, key_ops: [] }],
  ["duplicate usage", { ...publicJwk, key_ops: ["verify", "verify"] }],
  ["mismatched kid", { ...publicJwk, kid: ROTATED_KID }],
  ["invalid ext", { ...publicJwk, ext: "true" }],
  ["remote key URL", { ...publicJwk, jku: "https://attacker.invalid" }],
  ["certificate URL", { ...publicJwk, x5u: "https://attacker.invalid" }],
  ["empty coordinate", { ...publicJwk, x: "" }],
  ["invalid coordinate encoding", { ...publicJwk, x: "+".repeat(43) }],
  ["padded coordinate", { ...publicJwk, x: `${publicJwk.x}=` }],
  ["short coordinate", { ...publicJwk, x: base64url.encode(new Uint8Array(31)) }],
];
for (const [name, value] of BAD_JWKS) {
  Deno.test(`verification key import rejects ${name}`, async () => {
    await assert.rejects(importOfflineGrantVerificationKey(KID, value), { code: "invalid_key" });
  });
}

Deno.test(
  "off-curve public points cannot verify even when a runtime defers validation until use",
  async () => {
    const invalidKey = await importOfflineGrantVerificationKey(KID, {
      ...publicJwk,
      x: "A".repeat(43),
      y: "A".repeat(43),
    }).catch((error: unknown) => {
      assert.ok(error instanceof OfflineGrantCryptoError);
      assert.equal(error.code, "invalid_key");
      return null;
    });
    if (invalidKey) await rejectGrant(valid, "invalid_signature", context(), [invalidKey]);
  },
);

Deno.test(
  "verification never accepts a private, secret, wrong-curve or wrong-purpose CryptoKey",
  async () => {
    const secret = await generateSecret("HS256");
    const wrongCurve = await generateKeyPair("ES384");
    for (const key of [keyPair.privateKey, secret, wrongCurve.publicKey])
      await rejectGrant(valid, "invalid_key", context(), [{ ...publicKey, key }]);
    await rejectGrant(valid, "invalid_key", context(), [
      { ...publicKey, purpose: "api_authentication" as OfflineGrantKey["purpose"] },
    ]);
    await assert.rejects(signOfflineExecutionGrant(freeClaims(), publicKey, context()), {
      code: "invalid_key",
    });
    await assert.rejects(
      signOfflineExecutionGrant(
        freeClaims(),
        { ...signingKey, key: wrongCurve.privateKey },
        context(),
      ),
      { code: "invalid_key" },
    );
    await assert.rejects(
      signOfflineExecutionGrant(
        freeClaims(),
        { ...signingKey, purpose: "api_authentication" as OfflineGrantKey["purpose"] },
        context(),
      ),
      { code: "invalid_key" },
    );
  },
);

Deno.test(
  "verification key registry rejects duplicates, empty sets and unallowlisted keys",
  async () => {
    const expected = context();
    const rotation = {
      ...expected,
      binding: { ...expected.binding, allowedKeyIds: [KID, ROTATED_KID] },
    };
    await rejectGrant(valid, "invalid_key", context(), []);
    await rejectGrant(valid, "invalid_key", rotation, [publicKey, publicKey]);
    await rejectGrant(valid, "invalid_key", rotation, [rotatedKey]);
    await rejectGrant(valid, "invalid_key", context(), [publicKey, rotatedKey]);
    await rejectGrant(valid, "invalid_metadata", {
      ...expected,
      binding: { ...expected.binding, allowedKeyIds: [] },
    });
    await rejectGrant(valid, "invalid_metadata", {
      ...expected,
      binding: { ...expected.binding, allowedKeyIds: [KID, KID] },
    });
  },
);

Deno.test(
  "signing snapshots server-validated claims before asynchronous cryptography",
  async () => {
    const claims = { ...freeClaims(), release: structuredClone(RELEASE) };
    const pending = signOfflineExecutionGrant(claims, signingKey, context());
    claims.jti = "changed-after-call";
    claims.release.policy.sha256 = "f".repeat(64);
    const verified = await verifyOfflineExecutionGrant(await pending, [publicKey], context());
    assert.deepEqual(verified.claims, freeClaims());
  },
);

Deno.test(
  "verification snapshots independent context and key selection before asynchronous cryptography",
  async () => {
    const expected = {
      binding: { ...context().binding, allowedKeyIds: [KID] },
      release: structuredClone(RELEASE),
      nowEpochSeconds: NOW,
    };
    const entry = { ...publicKey };
    const pending = verifyOfflineExecutionGrant(valid, [entry], expected);
    expected.binding.issuer = "https://changed-after-call.invalid";
    expected.binding.allowedKeyIds.length = 0;
    expected.release.policy.version = "changed-after-call";
    expected.nowEpochSeconds = NOW + 604_800;
    entry.key = rotatedPair.publicKey;
    assert.deepEqual((await pending).claims, freeClaims());
  },
);

Deno.test(
  "signature envelopes are not independent release, billing, time or receipt authority",
  async () => {
    const verified = await verifyOfflineExecutionGrant(valid, [publicKey], context());
    assert.deepEqual(Object.keys(verified).sort(), [
      "claims",
      "grantJwsSha256",
      "protectedHeader",
      "transport",
      "verification",
    ]);
    assert.match(OFFLINE_SIGNATURE_TRUST_BOUNDARY, /not independent scientific release approval/);
    assert.match(
      OFFLINE_SIGNATURE_TRUST_BOUNDARY,
      /does not perform them or grant permissions by itself/,
    );
    assert.match(
      OFFLINE_SIGNATURE_TRUST_BOUNDARY,
      /No clock fallback, key provisioning, remote key discovery or state writes/,
    );
    assert.throws(() => {
      (verified.claims as { jti: string }).jti = "changed";
    }, TypeError);
    await assert.rejects(
      verifyOfflineExecutionGrant(
        tamperedSegment(2, base64url.encode(new Uint8Array(64))),
        [publicKey],
        context(),
      ),
      (error: unknown) => {
        assert.ok(error instanceof OfflineGrantCryptoError);
        assert.equal(error.code, "invalid_signature");
        assert.equal(error.message.includes(valid.compactJws), false);
        return true;
      },
    );
  },
);

// ---------------------------------------------------------------------------
// Key ring: rotation with a bounded overlap window (W04-03)
// ---------------------------------------------------------------------------

const P256_P = 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n;
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const coordinateToBigInt = (coordinate: string): bigint =>
  BigInt(
    "0x" +
      Array.from(base64url.decode(coordinate))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
  );
const bigIntToCoordinate = (value: bigint): string =>
  base64url.encode(
    Uint8Array.from(
      value
        .toString(16)
        .padStart(64, "0")
        .match(/../g)!
        .map((pair) => parseInt(pair, 16)),
    ),
  );

const ROTATED_PRIVATE_JWK = { ...(await exportJWK(rotatedPair.privateKey)), kid: ROTATED_KID };
const PREVIOUS_PUBLIC_JWK = { ...publicJwk, kid: KID };
const GRACE = OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS;
const MAX_OVERLAP = OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS;

function ringDocument(
  retiredAt: number,
  overlapEndsAt: number,
  previous: unknown = PREVIOUS_PUBLIC_JWK,
) {
  return {
    schemaVersion: OFFLINE_GRANT_KEY_RING_SCHEMA_VERSION,
    active: ROTATED_PRIVATE_JWK,
    previous: {
      jwk: previous,
      retiredAtEpochSeconds: retiredAt,
      overlapEndsAtEpochSeconds: overlapEndsAt,
    },
  };
}

function ringContext(
  allowedKeyIds: readonly string[],
  nowEpochSeconds: number,
): OfflineGrantVerificationContext {
  const expected = context();
  return {
    ...expected,
    binding: { ...expected.binding, allowedKeyIds: [...allowedKeyIds] },
    nowEpochSeconds,
  };
}

async function rejectRing(
  document: unknown,
  code: OfflineGrantCryptoError["code"],
  nowEpochSeconds = NOW,
): Promise<void> {
  await assert.rejects(importOfflineGrantKeyRing(document, nowEpochSeconds), {
    name: "OfflineGrantCryptoError",
    code,
  });
}

Deno.test("key ring rotation constants are the offline contract's bounds", () => {
  assert.equal(OFFLINE_GRANT_KEY_RING_SCHEMA_VERSION, 1);
  assert.equal(MAX_OVERLAP, OFFLINE_PRO_LEASE_MAX_SECONDS);
  assert.equal(Number.isSafeInteger(GRACE) && GRACE > 0 && GRACE < MAX_OVERLAP, true);
});

Deno.test(
  "a key ring signs with the active key only and verifies the previous key inside its overlap",
  async () => {
    const retiredAt = NOW + 60;
    const overlapEndsAt = retiredAt + 3 * 86_400;
    const ring = await importOfflineGrantKeyRing(ringDocument(retiredAt, overlapEndsAt), NOW);
    assert.deepEqual(ring.allowedKeyIds, [ROTATED_KID, KID]);
    assert.equal(ring.signingKey.kid, ROTATED_KID);
    assert.equal(ring.signingKey.key.type, "private");
    assert.equal(ring.activeKey.key.type, "public");
    assert.equal(ring.previousKey?.kid, KID);
    assert.equal(ring.previousKey?.key.type, "public");
    assert.equal(ring.previousKey?.retiredAtEpochSeconds, retiredAt);
    assert.equal(ring.previousKey?.overlapEndsAtEpochSeconds, overlapEndsAt);
    assert.equal(Object.isFrozen(ring), true);
    assert.equal(Object.isFrozen(ring.previousKey), true);

    // `valid` was signed under KID (now the previous key) at iat=NOW, before retirement.
    const inside = await verifyOfflineExecutionGrant(
      valid,
      ring,
      ringContext(ring.allowedKeyIds, overlapEndsAt - 1),
    );
    assert.equal(inside.protectedHeader.kid, KID);
    for (const now of [overlapEndsAt, overlapEndsAt + 1]) {
      await assert.rejects(
        verifyOfflineExecutionGrant(valid, ring, ringContext(ring.allowedKeyIds, now)),
        { name: "OfflineGrantCryptoError", code: "retired_key" },
      );
    }

    // New grants come from the active key and are unaffected by the window.
    const rotated = await signOfflineExecutionGrant(
      { ...freeClaims(), iat: overlapEndsAt, exp: overlapEndsAt + 3600 },
      ring.signingKey,
      ringContext(ring.allowedKeyIds, overlapEndsAt),
    );
    const verified = await verifyOfflineExecutionGrant(
      rotated,
      ring,
      ringContext(ring.allowedKeyIds, overlapEndsAt + 1),
    );
    assert.equal(verified.protectedHeader.kid, ROTATED_KID);

    // A legacy single private JWK is a ring without a previous key.
    const legacy = await importOfflineGrantKeyRing(ROTATED_PRIVATE_JWK, NOW);
    assert.deepEqual(legacy.allowedKeyIds, [ROTATED_KID]);
    assert.equal(legacy.previousKey, null);
    await assert.rejects(
      verifyOfflineExecutionGrant(valid, legacy, ringContext([KID, ROTATED_KID], NOW)),
      { name: "OfflineGrantCryptoError", code: "invalid_key" },
    );
  },
);

Deno.test(
  "the previous key may not mint past the propagation grace: iat > retiredAt + grace is retired_key, iat == retiredAt + grace is honoured",
  async () => {
    const retiredAt = NOW;
    const ring = await importOfflineGrantKeyRing(
      ringDocument(retiredAt, retiredAt + MAX_OVERLAP),
      NOW,
    );
    const late = await signOfflineExecutionGrant(
      { ...freeClaims(), iat: retiredAt + GRACE + 1, exp: retiredAt + GRACE + 3600 },
      signingKey,
      ringContext([KID], retiredAt + GRACE + 1),
    );
    await assert.rejects(
      verifyOfflineExecutionGrant(
        late,
        ring,
        ringContext(ring.allowedKeyIds, retiredAt + GRACE + 2),
      ),
      { name: "OfflineGrantCryptoError", code: "retired_key" },
    );
    const inGrace = await signOfflineExecutionGrant(
      { ...freeClaims(), iat: retiredAt + GRACE, exp: retiredAt + GRACE + 3600 },
      signingKey,
      ringContext([KID], retiredAt + GRACE),
    );
    const verified = await verifyOfflineExecutionGrant(
      inGrace,
      ring,
      ringContext(ring.allowedKeyIds, retiredAt + GRACE + 1),
    );
    assert.equal(verified.protectedHeader.kid, KID);
  },
);

Deno.test(
  "key ring import anchors retiredAt to the trusted clock and to the contract's Unix-seconds range",
  async () => {
    await importOfflineGrantKeyRing(ringDocument(NOW + GRACE, NOW + GRACE + MAX_OVERLAP), NOW);
    await importOfflineGrantKeyRing(
      ringDocument(NOW - 365 * 86_400, NOW - 365 * 86_400 + MAX_OVERLAP),
      NOW,
    );
    await rejectRing(ringDocument(NOW + GRACE + 1, NOW + GRACE + 1 + MAX_OVERLAP), "invalid_key");
    await rejectRing(ringDocument(NOW * 1000, NOW * 1000 + MAX_OVERLAP), "invalid_key");
    await rejectRing(
      ringDocument(Number.MAX_SAFE_INTEGER - MAX_OVERLAP, Number.MAX_SAFE_INTEGER),
      "invalid_key",
    );
    await rejectRing(
      ringDocument(253_402_300_800, 253_402_300_800),
      "invalid_key",
      253_402_300_799,
    );
    await rejectRing(ringDocument(NOW, NOW + MAX_OVERLAP + 1), "invalid_key");
    await rejectRing(ringDocument(NOW, NOW - 1), "invalid_key");
    await rejectRing(ringDocument(NOW, NOW), "invalid_time", Number.NaN);
    await rejectRing(ringDocument(NOW, NOW), "invalid_time", NOW + 0.5);
    await rejectRing(ROTATED_PRIVATE_JWK, "invalid_time", -1);
  },
);

Deno.test(
  "key ring import refuses private, colliding, mismatched, off-curve and negated-point material",
  async () => {
    const activePublic = await exportJWK(rotatedPair.publicKey);
    const negated = {
      kty: "EC",
      crv: "P-256",
      kid: KID,
      x: activePublic.x!,
      y: bigIntToCoordinate(P256_P - coordinateToBigInt(activePublic.y!)),
    };
    // The negated point is a genuine key pair (scalar n − d) …
    const negatedRing = await importOfflineGrantKeyRing(
      { ...negated, d: bigIntToCoordinate(P256_N - coordinateToBigInt(ROTATED_PRIVATE_JWK.d!)) },
      NOW,
    );
    assert.equal(negatedRing.signingKey.kid, KID);
    // … refused as previous material because it shares x with the active key.
    await rejectRing(ringDocument(NOW, NOW + 86_400, negated), "invalid_key");
    await rejectRing(ringDocument(NOW, NOW + 86_400, { ...activePublic, kid: KID }), "invalid_key");
    await rejectRing(ringDocument(NOW, NOW + 86_400, PRIVATE_JWK), "invalid_key");
    await rejectRing(
      ringDocument(NOW, NOW + 86_400, { ...publicJwk, kid: ROTATED_KID }),
      "invalid_key",
    );
    await rejectRing(
      ringDocument(NOW, NOW + 86_400, {
        ...publicJwk,
        kid: KID,
        x: "A".repeat(43),
        y: "A".repeat(43),
      }),
      "invalid_key",
    );
    await rejectRing({ ...ROTATED_PRIVATE_JWK, x: publicJwk.x }, "invalid_key");
    await rejectRing({ ...ringDocument(NOW, NOW + 86_400), schemaVersion: 2 }, "invalid_key");
    await rejectRing({ ...ringDocument(NOW, NOW + 86_400), active: activePublic }, "invalid_key");
    await rejectRing({ ...ringDocument(NOW, NOW + 86_400), extra: 1 }, "invalid_key");
    await rejectRing({ schemaVersion: 1, active: ROTATED_PRIVATE_JWK }, "invalid_key");

    // A grant signed with n − d under the previous kid is not honoured by an honest ring.
    const forged = await signOfflineExecutionGrant(freeClaims(), negatedRing.signingKey, context());
    const honest = await importOfflineGrantKeyRing(ringDocument(NOW, NOW + 86_400), NOW);
    await assert.rejects(
      verifyOfflineExecutionGrant(forged, honest, ringContext(honest.allowedKeyIds, NOW)),
      { name: "OfflineGrantCryptoError", code: "invalid_signature" },
    );
    await assert.rejects(
      verifyOfflineExecutionGrant(
        forged,
        [rotatedKey, publicKey],
        ringContext([KID, ROTATED_KID], NOW),
      ),
      { name: "OfflineGrantCryptoError", code: "invalid_signature" },
    );
  },
);

Deno.test(
  "list-mode verification honours a retired key's window and refuses an implausible one",
  async () => {
    const retiredAt = NOW + 60;
    const overlapEndsAt = retiredAt + 86_400;
    const ring = await importOfflineGrantKeyRing(ringDocument(retiredAt, overlapEndsAt), NOW);
    assert.ok(ring.previousKey);
    const list = [ring.activeKey, ring.previousKey];
    const inside = await verifyOfflineExecutionGrant(
      valid,
      list,
      ringContext(ring.allowedKeyIds, overlapEndsAt - 1),
    );
    assert.equal(inside.protectedHeader.kid, KID);
    await assert.rejects(
      verifyOfflineExecutionGrant(valid, list, ringContext(ring.allowedKeyIds, overlapEndsAt)),
      { name: "OfflineGrantCryptoError", code: "retired_key" },
    );
    // The window is read once, before any asynchronous work.
    const mutable = { ...ring.previousKey };
    const pending = verifyOfflineExecutionGrant(
      valid,
      [ring.activeKey, mutable],
      ringContext(ring.allowedKeyIds, overlapEndsAt),
    );
    mutable.overlapEndsAtEpochSeconds = overlapEndsAt + 86_400;
    await assert.rejects(pending, { name: "OfflineGrantCryptoError", code: "retired_key" });
    for (const entry of [
      { ...ring.previousKey, overlapEndsAtEpochSeconds: undefined },
      { ...ring.previousKey, overlapEndsAtEpochSeconds: retiredAt + MAX_OVERLAP + 1 },
      {
        ...ring.previousKey,
        retiredAtEpochSeconds: NOW + GRACE + 1,
        overlapEndsAtEpochSeconds: NOW + GRACE + 2,
      },
      {
        ...ring.previousKey,
        retiredAtEpochSeconds: NOW * 1000,
        overlapEndsAtEpochSeconds: NOW * 1000,
      },
    ]) {
      await rejectGrant(valid, "invalid_key", ringContext(ring.allowedKeyIds, NOW), [
        ring.activeKey,
        entry as OfflineGrantKey,
      ]);
    }
    // Unadorned keys (no window) keep verifying exactly as before.
    await verifyOfflineExecutionGrant(valid, [publicKey], context());
  },
);
