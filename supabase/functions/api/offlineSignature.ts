import { base64url, importJWK, jwtVerify, SignJWT, type JWK, type JWTPayload } from "jose";
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
  validateOfflineSignedGrantShape,
  type OfflineExecutionGrantClaims,
  type OfflineGrantBinding,
  type OfflineGrantProtectedHeader,
  type OfflineProLease,
  type OfflineReleasedArtifacts,
  type OfflineSignedExecutionGrant,
} from "../../../packages/shared-types/src/offlineAuthorization.ts";
import { canonicalizeOfflineJson, digestOfflineGrantTransport } from "./canonicalDigest.ts";

export const OFFLINE_SIGNATURE_TRUST_BOUNDARY =
  "ES256 verification establishes only the compact envelope and its configured bindings. It is not independent scientific release approval, billing permission, account authentication, store verification, trusted time, App Attest proof or replay protection. Signing accepts only claims already authorized by the server after those independent checks; it does not perform them or grant permissions by itself. Keys, expected bindings, release references and nowEpochSeconds must come from independent trusted configuration/state, never from the presented token. No clock fallback, key provisioning, remote key discovery or state writes occur here.";

export interface OfflineGrantKey {
  readonly purpose: typeof OFFLINE_JWS_REQUIREMENTS.keyPurpose;
  readonly kid: string;
  readonly key: CryptoKey;
}

export interface OfflineGrantVerificationContext {
  readonly binding: OfflineGrantBinding;
  readonly release: OfflineReleasedArtifacts;
  readonly nowEpochSeconds: number;
}

export interface VerifiedOfflineGrantEnvelope {
  readonly verification: "signature_and_bindings_only";
  readonly transport: OfflineSignedExecutionGrant;
  readonly protectedHeader: OfflineGrantProtectedHeader;
  readonly claims: OfflineExecutionGrantClaims;
  readonly grantJwsSha256: string;
}

export class OfflineGrantCryptoError extends Error {
  constructor(
    readonly code:
      | "invalid_transport"
      | "invalid_metadata"
      | "invalid_key"
      | "invalid_time"
      | "invalid_release_binding"
      | "invalid_signature"
      | "signing_failed",
  ) {
    super(`Offline grant rejected: ${code}`);
    this.name = "OfflineGrantCryptoError";
  }
}

export async function importOfflineGrantVerificationKey(
  kid: string,
  publicJwk: unknown,
): Promise<OfflineGrantKey> {
  try {
    const jwk: JWK = JSON.parse(canonicalizeOfflineJson(publicJwk));
    const allowedFields = ["kty", "crv", "x", "y", "alg", "use", "key_ops", "kid", "ext"];
    if (
      !jwk ||
      typeof kid !== "string" ||
      Object.keys(jwk).some((key) => !allowedFields.includes(key)) ||
      jwk.kty !== "EC" ||
      jwk.crv !== "P-256" ||
      (jwk.alg !== undefined && jwk.alg !== "ES256") ||
      (jwk.use !== undefined && jwk.use !== "sig") ||
      (jwk.kid !== undefined && jwk.kid !== kid) ||
      (jwk.ext !== undefined && typeof jwk.ext !== "boolean") ||
      (jwk.key_ops !== undefined &&
        (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== "verify"))
    ) {
      throw new OfflineGrantCryptoError("invalid_key");
    }
    for (const coordinate of [jwk.x, jwk.y]) {
      if (typeof coordinate !== "string") throw new OfflineGrantCryptoError("invalid_key");
      const decoded = base64url.decode(coordinate);
      if (decoded.byteLength !== 32 || base64url.encode(decoded) !== coordinate) {
        throw new OfflineGrantCryptoError("invalid_key");
      }
    }
    const key = await importJWK({ ...jwk, ext: false }, "ES256");
    if (!(key instanceof CryptoKey)) throw new OfflineGrantCryptoError("invalid_key");
    const entry = Object.freeze({ purpose: OFFLINE_JWS_REQUIREMENTS.keyPurpose, kid, key });
    requireKey(entry, "verify");
    return entry;
  } catch {
    throw new OfflineGrantCryptoError("invalid_key");
  }
}

/** Server-only signing key from configuration (a private P-256 JWK carrying
 * its `kid`). The key is imported non-extractable with the single `sign`
 * usage; anything else — a public key, a foreign curve, a missing kid, extra
 * members — is `invalid_key`. Provisioning and rotation happen outside. */
export async function importOfflineGrantSigningKey(privateJwk: unknown): Promise<OfflineGrantKey> {
  try {
    const jwk: JWK = JSON.parse(canonicalizeOfflineJson(privateJwk));
    const allowedFields = ["kty", "crv", "x", "y", "d", "alg", "use", "key_ops", "kid", "ext"];
    if (
      !jwk ||
      Object.keys(jwk).some((key) => !allowedFields.includes(key)) ||
      jwk.kty !== "EC" ||
      jwk.crv !== "P-256" ||
      !isKeyIdentifier(jwk.kid) ||
      (jwk.alg !== undefined && jwk.alg !== "ES256") ||
      (jwk.use !== undefined && jwk.use !== "sig") ||
      (jwk.ext !== undefined && typeof jwk.ext !== "boolean") ||
      (jwk.key_ops !== undefined &&
        (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== "sign"))
    ) {
      throw new OfflineGrantCryptoError("invalid_key");
    }
    for (const coordinate of [jwk.x, jwk.y, jwk.d]) {
      if (typeof coordinate !== "string") throw new OfflineGrantCryptoError("invalid_key");
      const decoded = base64url.decode(coordinate);
      if (decoded.byteLength !== 32 || base64url.encode(decoded) !== coordinate) {
        throw new OfflineGrantCryptoError("invalid_key");
      }
    }
    const key = await importJWK({ ...jwk, ext: false }, "ES256");
    if (!(key instanceof CryptoKey)) throw new OfflineGrantCryptoError("invalid_key");
    const entry = Object.freeze({
      purpose: OFFLINE_JWS_REQUIREMENTS.keyPurpose,
      kid: jwk.kid,
      key,
    });
    requireKey(entry, "sign");
    return entry;
  } catch {
    throw new OfflineGrantCryptoError("invalid_key");
  }
}

/** What the server already established about the caller and the release
 * before it asked the database for a grant. Never taken from the request. */
export interface OfflineGrantIssuanceBinding {
  readonly issuer: string;
  readonly ownerId: string;
  readonly installationKeyId: string;
  readonly release: OfflineReleasedArtifacts;
}

export type OfflineGrantIssuanceRefusal =
  | "row_malformed"
  | "row_not_accepted"
  | "expiry_not_after_issuance"
  | "expiry_exceeds_maximum"
  | "expiry_exceeds_entitlement"
  | "entitlement_expired"
  | "tickets_invalid"
  | "claims_invalid";

export class OfflineGrantIssuanceError extends Error {
  constructor(readonly reason: OfflineGrantIssuanceRefusal) {
    super(`Offline grant issuance refused: ${reason}`);
    this.name = "OfflineGrantIssuanceError";
  }
}

/** Claims for an `issue_offline_grant()` row that the database ACCEPTED. The
 * SQL decided authorization, allocation and expiry; this only re-checks the
 * row against the shared grant contract (uuid ids, positive generation,
 * `issued < expires ≤ issued + 7d`, a Pro lease never past its verified
 * entitlement, 1–2 unique free tickets and none for Pro) and refuses to
 * build claims from anything else. Instants are floored to whole seconds,
 * so a lease never rounds past what the row allows. */
export function offlineGrantClaimsFromIssuance(
  row: unknown,
  binding: OfflineGrantIssuanceBinding,
): OfflineExecutionGrantClaims {
  if (!isPlainRecord(row)) throw new OfflineGrantIssuanceError("row_malformed");
  if (row.result !== "accepted") throw new OfflineGrantIssuanceError("row_not_accepted");
  const grantId = row.grant_id;
  const generation = row.generation;
  const source = row.entitlement_source;
  const issuedAt = epochSecondsOf(row.issued_at);
  const expiresAt = epochSecondsOf(row.expires_at);
  if (
    !isUuid(grantId) ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    (source !== "verified_store" && source !== "identity_lifetime_free") ||
    issuedAt === null ||
    expiresAt === null
  ) {
    throw new OfflineGrantIssuanceError("row_malformed");
  }
  if (expiresAt <= issuedAt) throw new OfflineGrantIssuanceError("expiry_not_after_issuance");
  if (expiresAt - issuedAt > OFFLINE_PRO_LEASE_MAX_SECONDS) {
    throw new OfflineGrantIssuanceError("expiry_exceeds_maximum");
  }
  const ticketIds = row.ticket_ids;
  if (!Array.isArray(ticketIds) || !ticketIds.every(isUuid)) {
    throw new OfflineGrantIssuanceError("row_malformed");
  }
  const base = {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: binding.issuer,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: binding.ownerId,
    jti: grantId,
    installationKeyId: binding.installationKeyId,
    iat: issuedAt,
    exp: expiresAt,
    capabilities: ["analyze_joint_output"] as const,
    release: binding.release,
  };
  let claims: OfflineExecutionGrantClaims;
  if (source === "verified_store") {
    if (ticketIds.length !== 0) throw new OfflineGrantIssuanceError("tickets_invalid");
    let lease: OfflineProLease;
    if (row.entitlement_expires_at === null) {
      lease = {
        schemaVersion: OFFLINE_PRO_LEASE_SCHEMA_VERSION,
        kind: "lifetime",
        verifiedEntitlementExpiresAt: null,
      };
    } else {
      const entitlementExpiresAt = epochSecondsOf(row.entitlement_expires_at);
      if (entitlementExpiresAt === null) throw new OfflineGrantIssuanceError("row_malformed");
      if (entitlementExpiresAt <= issuedAt) {
        throw new OfflineGrantIssuanceError("entitlement_expired");
      }
      if (expiresAt > entitlementExpiresAt) {
        throw new OfflineGrantIssuanceError("expiry_exceeds_entitlement");
      }
      lease = {
        schemaVersion: OFFLINE_PRO_LEASE_SCHEMA_VERSION,
        kind: "subscription",
        verifiedEntitlementExpiresAt: entitlementExpiresAt,
      };
    }
    claims = { ...base, entitlementSource: "verified_store", lease };
  } else {
    if (row.entitlement_expires_at !== null) throw new OfflineGrantIssuanceError("row_malformed");
    if (
      ticketIds.length < 1 ||
      ticketIds.length > 2 ||
      new Set(ticketIds).size !== ticketIds.length
    ) {
      throw new OfflineGrantIssuanceError("tickets_invalid");
    }
    claims = {
      ...base,
      entitlementSource: "identity_lifetime_free",
      allocation: {
        schemaVersion: OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
        allocationId: grantId,
        generation,
        ticketIds: [...ticketIds],
        budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
        financialExpiry: "reconciliation_only",
      },
    };
  }
  const checked = validateOfflineExecutionGrantMetadata(
    { alg: "ES256", typ: OFFLINE_GRANT_JWS_TYPE, kid: ISSUANCE_SHAPE_CHECK_KID },
    claims,
    {
      issuer: binding.issuer,
      allowedKeyIds: [ISSUANCE_SHAPE_CHECK_KID],
      ownerId: binding.ownerId,
      installationKeyId: binding.installationKeyId,
    },
  );
  if (!checked.ok) throw new OfflineGrantIssuanceError("claims_invalid");
  return checked.value;
}

/** Placeholder kid for the shape check above only: the real protected header
 * is built by `signOfflineExecutionGrant` from the configured signing key. */
const ISSUANCE_SHAPE_CHECK_KID = "issuance-shape-check";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

function isKeyIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:/+=-]{1,128}$/.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A PostgREST/to_jsonb timestamptz (`2026-09-09T04:25:00.123456+00:00`) or
 * an ISO-8601 UTC instant, floored to whole seconds; anything else is null. */
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
function epochSecondsOf(value: unknown): number | null {
  if (typeof value !== "string" || !INSTANT_PATTERN.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 1000);
}

export async function signOfflineExecutionGrant(
  serverValidatedClaims: OfflineExecutionGrantClaims,
  signingKey: OfflineGrantKey,
  expected: OfflineGrantVerificationContext,
): Promise<OfflineSignedExecutionGrant> {
  const key = requireKey(signingKey, "sign");
  const header: OfflineGrantProtectedHeader = {
    alg: "ES256",
    typ: OFFLINE_GRANT_JWS_TYPE,
    kid: signingKey.kid,
  };
  const context = snapshotContext(expected);
  const claims = validateBoundClaims(header, serverValidatedClaims, context);
  canonicalizeOfflineJson(claims);
  let compactJws: string;
  try {
    compactJws = await new SignJWT(claims as unknown as JWTPayload)
      .setProtectedHeader({ ...header })
      .sign(key);
  } catch {
    throw new OfflineGrantCryptoError("signing_failed");
  }
  const transport = validateOfflineSignedGrantShape({
    schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
    compactJws,
  });
  if (!transport.ok) throw new OfflineGrantCryptoError("invalid_transport");
  return transport.value;
}

export async function verifyOfflineExecutionGrant(
  raw: unknown,
  verificationKeys: readonly OfflineGrantKey[],
  expected: OfflineGrantVerificationContext,
): Promise<VerifiedOfflineGrantEnvelope> {
  const parsed = validateOfflineSignedGrantShape(raw);
  if (!parsed.ok) throw new OfflineGrantCryptoError("invalid_transport");
  const transport = parsed.value;
  const [headerSegment, payloadSegment] = transport.compactJws.split(".");
  const header = decodeJsonSegment(headerSegment);
  const claims = decodeJsonSegment(payloadSegment);
  const context = snapshotContext(expected);
  validateBoundClaims(header, claims, context);
  const kid = (header as OfflineGrantProtectedHeader).kid;
  const keys = verificationKeyMap(verificationKeys, context.binding.allowedKeyIds);
  const key = keys.get(kid);
  if (!key) throw new OfflineGrantCryptoError("invalid_key");
  let verified;
  try {
    verified = await jwtVerify(transport.compactJws, key, {
      algorithms: ["ES256"],
      typ: OFFLINE_GRANT_JWS_TYPE,
      issuer: context.binding.issuer,
      audience: OFFLINE_GRANT_AUDIENCE,
      subject: context.binding.ownerId,
      requiredClaims: ["iss", "aud", "sub", "iat", "exp", "jti"],
      currentDate: new Date(context.nowEpochSeconds * 1000),
      clockTolerance: 0,
    });
  } catch {
    throw new OfflineGrantCryptoError("invalid_signature");
  }
  const verifiedClaims = validateBoundClaims(verified.protectedHeader, verified.payload, context);
  return Object.freeze({
    verification: "signature_and_bindings_only",
    transport,
    protectedHeader: Object.freeze({ alg: "ES256", typ: OFFLINE_GRANT_JWS_TYPE, kid }),
    claims: verifiedClaims,
    grantJwsSha256: await digestOfflineGrantTransport(transport),
  });
}

type ContextSnapshot = {
  binding: OfflineGrantBinding;
  releaseJson: string;
  nowEpochSeconds: number;
};

function snapshotContext(expected: OfflineGrantVerificationContext): ContextSnapshot {
  try {
    return {
      binding: JSON.parse(canonicalizeOfflineJson(expected.binding)),
      releaseJson: canonicalizeOfflineJson(expected.release),
      nowEpochSeconds: expected.nowEpochSeconds,
    };
  } catch {
    throw new OfflineGrantCryptoError("invalid_metadata");
  }
}

function validateBoundClaims(
  header: unknown,
  raw: unknown,
  context: ContextSnapshot,
): OfflineExecutionGrantClaims {
  const parsed = validateOfflineExecutionGrantMetadata(header, raw, context.binding);
  if (!parsed.ok) throw new OfflineGrantCryptoError("invalid_metadata");
  const claims = parsed.value;
  if (
    !Number.isSafeInteger(context.nowEpochSeconds) ||
    Object.is(context.nowEpochSeconds, -0) ||
    context.nowEpochSeconds < claims.iat ||
    context.nowEpochSeconds >= claims.exp
  ) {
    throw new OfflineGrantCryptoError("invalid_time");
  }
  if (canonicalizeOfflineJson(claims.release) !== context.releaseJson) {
    throw new OfflineGrantCryptoError("invalid_release_binding");
  }
  return claims;
}

function decodeJsonSegment(segment: string): unknown {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const parsed: unknown = JSON.parse(decoder.decode(base64url.decode(segment)));
    canonicalizeOfflineJson(parsed);
    return parsed;
  } catch {
    throw new OfflineGrantCryptoError("invalid_transport");
  }
}

function requireKey(entry: OfflineGrantKey, usage: "sign" | "verify"): CryptoKey {
  if (
    !entry ||
    entry.purpose !== OFFLINE_JWS_REQUIREMENTS.keyPurpose ||
    typeof entry.kid !== "string" ||
    !(entry.key instanceof CryptoKey) ||
    entry.key.type !== (usage === "sign" ? "private" : "public") ||
    entry.key.algorithm.name !== "ECDSA" ||
    (entry.key.algorithm as EcKeyAlgorithm).namedCurve !== "P-256" ||
    entry.key.usages.length !== 1 ||
    entry.key.usages[0] !== usage
  ) {
    throw new OfflineGrantCryptoError("invalid_key");
  }
  return entry.key;
}

function verificationKeyMap(
  entries: readonly OfflineGrantKey[],
  allowedKeyIds: readonly string[],
): Map<string, CryptoKey> {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > allowedKeyIds.length) {
    throw new OfflineGrantCryptoError("invalid_key");
  }
  const keys = new Map<string, CryptoKey>();
  for (const entry of entries) {
    const key = requireKey(entry, "verify");
    if (keys.has(entry.kid) || !allowedKeyIds.includes(entry.kid)) {
      throw new OfflineGrantCryptoError("invalid_key");
    }
    keys.set(entry.kid, key);
  }
  return keys;
}
