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

/** The previous signing key after a rotation: public half only, with the
 * instant it stopped signing and the exclusive end of its overlap window. */
export interface OfflineGrantRetiredKey extends OfflineGrantKey {
  readonly retiredAtEpochSeconds: number;
  readonly overlapEndsAtEpochSeconds: number;
}

/** The configured signing material: exactly one active key (private half for
 * signing, public half for verification) and at most one retired key whose
 * signatures are honoured only inside its bounded overlap window. */
export interface OfflineGrantKeyRing {
  readonly signingKey: OfflineGrantKey;
  readonly activeKey: OfflineGrantKey;
  readonly previousKey: OfflineGrantRetiredKey | null;
  readonly allowedKeyIds: readonly string[];
}

export const OFFLINE_GRANT_KEY_RING_SCHEMA_VERSION = 1;

/** A retired key may keep verifying for at most one maximal lease: every
 * grant it legitimately signed has expired by then, so a longer window only
 * ever serves a compromised key. */
export const OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS = OFFLINE_PRO_LEASE_MAX_SECONDS;

/** How long after `retiredAtEpochSeconds` the previous key may still have
 * issued a grant this verifier honours. The operator records the retirement
 * instant when the rotated secret is set; the old secret stays live in
 * already-running isolates until the new value propagates, and every grant
 * the server issued in that window was spent and may be held offline. The
 * same bound caps how far ahead of the trusted clock a retirement may be
 * placed, so the window can never be anchored to an implausible instant. */
export const OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS = 3_600;

/** Last instant the offline contract treats as Unix seconds
 * (9999-12-31T23:59:59Z); anything later is a unit slip, not a schedule. */
const OFFLINE_KEY_ROTATION_MAX_EPOCH_SECONDS = 253_402_300_799;

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
      | "retired_key"
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
    const { x, y } = jwk;
    if (typeof x !== "string" || typeof y !== "string") {
      throw new OfflineGrantCryptoError("invalid_key");
    }
    for (const coordinate of [x, y]) {
      const decoded = base64url.decode(coordinate);
      if (decoded.byteLength !== 32 || base64url.encode(decoded) !== coordinate) {
        throw new OfflineGrantCryptoError("invalid_key");
      }
    }
    if (!isP256Point(x, y)) throw new OfflineGrantCryptoError("invalid_key");
    const key = await importJWK({ ...jwk, ext: false }, "ES256");
    if (!(key instanceof CryptoKey)) throw new OfflineGrantCryptoError("invalid_key");
    const entry = Object.freeze({ purpose: OFFLINE_JWS_REQUIREMENTS.keyPurpose, kid, key });
    requireKey(entry, "verify");
    return entry;
  } catch {
    throw new OfflineGrantCryptoError("invalid_key");
  }
}

// P-256 (secp256r1) domain parameters: field prime, curve constant b and group order.
const P256_P = BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
const P256_B = BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b");
const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

function coordinateToBigInt(coordinate: string): bigint {
  const bytes = base64url.decode(coordinate);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return BigInt(`0x${hex === "" ? "0" : hex}`);
}

/** `(x, y)` is an affine point on P-256: both coordinates are field elements
 * and `y² ≡ x³ − 3x + b (mod p)`. WebCrypto runtimes may defer this check
 * until use; a key that can never verify must not import. */
function isP256Point(x: string, y: string): boolean {
  const fx = coordinateToBigInt(x);
  const fy = coordinateToBigInt(y);
  if (fx >= P256_P || fy >= P256_P) return false;
  const lhs = (fy * fy) % P256_P;
  const rhs = (((fx * fx * fx - 3n * fx) % P256_P) + P256_B + P256_P) % P256_P;
  return lhs === rhs;
}

/** Signing key material is only usable when its private scalar `d` is a
 * valid group element AND the public coordinates it carries belong to `d`:
 * a signature produced with `d` must verify under `(x, y)`. Otherwise the key
 * would sign grants that its own public half — and every verifier configured
 * from it — rejects. */
async function importSigningKeyPair(
  privateJwk: unknown,
): Promise<{ signingKey: OfflineGrantKey; activeKey: OfflineGrantKey; x: string }> {
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
    const { x, y, d } = jwk;
    if (typeof x !== "string" || typeof y !== "string" || typeof d !== "string") {
      throw new OfflineGrantCryptoError("invalid_key");
    }
    for (const coordinate of [x, y, d]) {
      const decoded = base64url.decode(coordinate);
      if (decoded.byteLength !== 32 || base64url.encode(decoded) !== coordinate) {
        throw new OfflineGrantCryptoError("invalid_key");
      }
    }
    const scalar = coordinateToBigInt(d);
    if (scalar === 0n || scalar >= P256_N || !isP256Point(x, y)) {
      throw new OfflineGrantCryptoError("invalid_key");
    }
    const key = await importJWK({ ...jwk, ext: false }, "ES256");
    if (!(key instanceof CryptoKey)) throw new OfflineGrantCryptoError("invalid_key");
    const signingKey = Object.freeze({
      purpose: OFFLINE_JWS_REQUIREMENTS.keyPurpose,
      kid: jwk.kid,
      key,
    });
    requireKey(signingKey, "sign");
    const activeKey = await importOfflineGrantVerificationKey(jwk.kid, {
      kty: "EC",
      crv: "P-256",
      x,
      y,
      kid: jwk.kid,
    });
    const probe = new TextEncoder().encode(
      `${OFFLINE_JWS_REQUIREMENTS.keyPurpose}:key-consistency:${jwk.kid}`,
    );
    const algorithm = { name: "ECDSA", hash: "SHA-256" };
    const signature = await crypto.subtle.sign(algorithm, signingKey.key, probe);
    if (!(await crypto.subtle.verify(algorithm, activeKey.key, signature, probe))) {
      throw new OfflineGrantCryptoError("invalid_key");
    }
    return { signingKey, activeKey, x };
  } catch {
    throw new OfflineGrantCryptoError("invalid_key");
  }
}

/** Server-only signing key from configuration (a private P-256 JWK carrying
 * its `kid`). The key is imported non-extractable with the single `sign`
 * usage; anything else — a public key, a foreign curve, a missing kid, extra
 * members — is `invalid_key`. Provisioning and rotation happen outside. */
export async function importOfflineGrantSigningKey(privateJwk: unknown): Promise<OfflineGrantKey> {
  return (await importSigningKeyPair(privateJwk)).signingKey;
}

/** Server-only key ring from configuration, anchored to the trusted clock.
 * Accepts either a bare private P-256 JWK (a ring with no previous key) or
 * `{ schemaVersion: 1, active: <private JWK>, previous: null | { jwk: <public
 * JWK>, retiredAtEpochSeconds, overlapEndsAtEpochSeconds } }` where
 * `retiredAt ≤ nowEpochSeconds + PROPAGATION_GRACE` and
 * `retiredAt ≤ overlapEndsAt ≤ retiredAt + MAX_OVERLAP`, all Unix seconds.
 * Private material for the previous key, a previous kid equal to the active
 * kid, a previous point sharing the active key's x coordinate (the point
 * itself or its negation — one private scalar would then control both kids),
 * an active key whose public coordinates do not belong to its `d`,
 * coordinates off the curve, unknown members, an unbounded window or a
 * retirement instant the clock cannot corroborate are `invalid_key`; a
 * `nowEpochSeconds` that is not Unix seconds is `invalid_time`. */
export async function importOfflineGrantKeyRing(
  configured: unknown,
  nowEpochSeconds: number,
): Promise<OfflineGrantKeyRing> {
  if (!isEpochSeconds(nowEpochSeconds)) throw new OfflineGrantCryptoError("invalid_time");
  if (!isPlainRecord(configured)) throw new OfflineGrantCryptoError("invalid_key");
  let activeJwk: unknown = configured;
  let previousEntry: unknown = null;
  if (!("kty" in configured)) {
    const allowedFields = ["schemaVersion", "active", "previous"];
    if (
      Object.keys(configured).some((key) => !allowedFields.includes(key)) ||
      configured.schemaVersion !== OFFLINE_GRANT_KEY_RING_SCHEMA_VERSION ||
      !("active" in configured) ||
      !("previous" in configured)
    ) {
      throw new OfflineGrantCryptoError("invalid_key");
    }
    activeJwk = configured.active;
    previousEntry = configured.previous;
  }
  const { signingKey, activeKey, x } = await importSigningKeyPair(activeJwk);
  const previousKey =
    previousEntry === null
      ? null
      : await importRetiredKey(previousEntry, { kid: signingKey.kid, x }, nowEpochSeconds);
  return Object.freeze({
    signingKey,
    activeKey,
    previousKey,
    allowedKeyIds: Object.freeze(
      previousKey === null ? [signingKey.kid] : [signingKey.kid, previousKey.kid],
    ),
  });
}

const isEpochSeconds = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  !Object.is(value, -0) &&
  (value as number) >= 0 &&
  (value as number) <= OFFLINE_KEY_ROTATION_MAX_EPOCH_SECONDS;

type RetirementWindow = Readonly<
  Pick<OfflineGrantRetiredKey, "retiredAtEpochSeconds" | "overlapEndsAtEpochSeconds">
>;

/** A retirement window is Unix seconds at both ends, at most one maximal
 * lease long, and starts no later than one propagation grace after the
 * trusted clock — so the bound is relative to a real instant, never to a
 * millisecond value or a far-future one. */
function isBoundedRetirementWindow(
  retiredAt: number,
  overlapEndsAt: number,
  nowEpochSeconds: number,
): boolean {
  return (
    isEpochSeconds(retiredAt) &&
    isEpochSeconds(overlapEndsAt) &&
    isEpochSeconds(nowEpochSeconds) &&
    overlapEndsAt >= retiredAt &&
    overlapEndsAt - retiredAt <= OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS &&
    retiredAt <= nowEpochSeconds + OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS
  );
}

async function importRetiredKey(
  entry: unknown,
  active: { kid: string; x: string },
  nowEpochSeconds: number,
): Promise<OfflineGrantRetiredKey> {
  const allowedFields = ["jwk", "retiredAtEpochSeconds", "overlapEndsAtEpochSeconds"];
  if (
    !isPlainRecord(entry) ||
    Object.keys(entry).some((key) => !allowedFields.includes(key)) ||
    !isPlainRecord(entry.jwk) ||
    !isKeyIdentifier(entry.jwk.kid) ||
    entry.jwk.kid === active.kid ||
    !isEpochSeconds(entry.retiredAtEpochSeconds) ||
    !isEpochSeconds(entry.overlapEndsAtEpochSeconds) ||
    !isBoundedRetirementWindow(
      entry.retiredAtEpochSeconds,
      entry.overlapEndsAtEpochSeconds,
      nowEpochSeconds,
    )
  ) {
    throw new OfflineGrantCryptoError("invalid_key");
  }
  const key = await importOfflineGrantVerificationKey(entry.jwk.kid, entry.jwk);
  if (
    typeof entry.jwk.x !== "string" ||
    coordinateToBigInt(entry.jwk.x) === coordinateToBigInt(active.x)
  ) {
    throw new OfflineGrantCryptoError("invalid_key");
  }
  return Object.freeze({
    ...key,
    retiredAtEpochSeconds: entry.retiredAtEpochSeconds,
    overlapEndsAtEpochSeconds: entry.overlapEndsAtEpochSeconds,
  });
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
  verificationKeys: OfflineGrantKeyRing | readonly OfflineGrantKey[],
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
  const entries = isKeyList(verificationKeys)
    ? verificationKeys
    : ringVerificationKeys(verificationKeys, context.binding.allowedKeyIds);
  const retirements = retirementWindows(entries, context.nowEpochSeconds);
  const keys = verificationKeyMap(entries, context.binding.allowedKeyIds);
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
  const retired = retirements.get(kid);
  if (
    retired !== undefined &&
    (context.nowEpochSeconds >= retired.overlapEndsAtEpochSeconds ||
      verifiedClaims.iat >
        retired.retiredAtEpochSeconds + OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS)
  ) {
    throw new OfflineGrantCryptoError("retired_key");
  }
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

function isKeyList(
  value: OfflineGrantKeyRing | readonly OfflineGrantKey[],
): value is readonly OfflineGrantKey[] {
  return Array.isArray(value);
}

/** The ring's keys the binding still allowlists. The allowlist can only
 * narrow the ring; a kid it names that the ring does not hold is simply
 * absent (and `invalid_key` when a grant presents it). */
function ringVerificationKeys(
  ring: OfflineGrantKeyRing,
  allowedKeyIds: readonly string[],
): readonly OfflineGrantKey[] {
  if (!isPlainRecord(ring) || !ring.activeKey || !Array.isArray(allowedKeyIds)) {
    throw new OfflineGrantCryptoError("invalid_key");
  }
  const held = ring.previousKey === null ? [ring.activeKey] : [ring.activeKey, ring.previousKey];
  return held.filter((entry) => isPlainRecord(entry) && allowedKeyIds.includes(entry.kid));
}

/** Snapshot of every retirement window the presented keys carry, taken
 * before any asynchronous cryptography so a key object mutated
 * mid-verification cannot widen it. A window must be complete, bounded and
 * anchored no later than one propagation grace after the trusted clock. */
function retirementWindows(
  entries: readonly OfflineGrantKey[],
  nowEpochSeconds: number,
): Map<string, RetirementWindow> {
  const windows = new Map<string, RetirementWindow>();
  if (!Array.isArray(entries)) throw new OfflineGrantCryptoError("invalid_key");
  for (const entry of entries) {
    if (!isPlainRecord(entry)) throw new OfflineGrantCryptoError("invalid_key");
    const candidate: Partial<OfflineGrantRetiredKey> = entry;
    const retiredAt = candidate.retiredAtEpochSeconds;
    const overlapEndsAt = candidate.overlapEndsAtEpochSeconds;
    if (retiredAt === undefined && overlapEndsAt === undefined) continue;
    if (
      !isKeyIdentifier(candidate.kid) ||
      !isEpochSeconds(retiredAt) ||
      !isEpochSeconds(overlapEndsAt) ||
      !isBoundedRetirementWindow(retiredAt, overlapEndsAt, nowEpochSeconds)
    ) {
      throw new OfflineGrantCryptoError("invalid_key");
    }
    windows.set(candidate.kid, {
      retiredAtEpochSeconds: retiredAt,
      overlapEndsAtEpochSeconds: overlapEndsAt,
    });
  }
  return windows;
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
