import {
  resolveAnalysisReleaseEligibility,
  validateAnalysisReleaseApproval,
  validateAnalysisReleasePolicy,
  type AnalysisReleaseApproval,
  type AnalysisReleaseEligibility,
  type AnalysisReleasePolicyDocument,
} from '@pickle/shared-types';
import { sha256Hex } from '@pickle/swing-domain';
import { ApiError, type ReleasePolicyClient } from '../data/api';
import type { LocalDb } from '../data/db';
import { getKv, setKv } from '../data/repository';
import {
  evaluateLease,
  trustedTime,
  TRUSTED_TIME_LEASE_MAX_MS,
  type TrustedTimeReading,
} from '../data/trustedTime';
import {
  RELEASE_NOT_AUTHORIZED_CODE,
  RELEASE_NOT_AUTHORIZED_MESSAGE,
} from './partialOutcome';

/**
 * Mobile side of the analysis release authority.
 *
 * The Edge function answers `GET /v1/analysis/release-policy` with the
 * installed policy document, its RFC 8785 canonical bytes and the approval
 * record whose `policy.sha256` is the digest of those bytes. This module
 * re-derives both — the canonical bytes from the document and the SHA-256
 * from the bytes — exactly as `supabase/functions/api/releasePolicy.ts` does
 * for the stored row, so a document, bytes and digest that disagree are never
 * a policy. A verified ACTIVE answer is kept in one bounded cache slot bound
 * to the signed-in account and API origin; offline, that slot authorizes a
 * numerical run only while the trusted clock proves it is still inside its
 * validity window. Without a verified active policy nothing is reserved and
 * nothing numerical is published.
 */

export const RELEASE_AUTHORITY_SCHEMA_VERSION = 'analysis-release-authority-v1';
export const RELEASE_POLICY_CACHE_SCHEMA_VERSION =
  'mobile-release-policy-cache-v1';
/** One slot per signed-in account (`<namespace>:<owner>`, listed in
 * repository.ts OWNER_SCOPED_KV_NAMESPACES so account deletion purges it);
 * the record additionally names its account + origin. */
export const RELEASE_POLICY_CACHE_KV_NAMESPACE = 'analysis.release-policy';
export function releasePolicyCacheKeyForOwner(ownerKey: string): string {
  return `${RELEASE_POLICY_CACHE_KV_NAMESPACE}:${ownerKey}`;
}
/** The stored authority row bounds its canonical bytes to 64 KiB. */
export const RELEASE_POLICY_MAX_CANONICAL_BYTES = 65_536;
/** Document + canonical bytes + approval + envelope, with headroom. */
export const RELEASE_POLICY_CACHE_MAX_BYTES = 196_608;
/** A cached policy is never honoured longer than this after it was fetched,
 * however long its own window runs: the same bound offline leases carry. */
export const RELEASE_POLICY_CACHE_MAX_AGE_MS = TRUSTED_TIME_LEASE_MAX_MS;
export const RELEASE_POLICY_CANONICAL_JSON_LIMITS = Object.freeze({
  maxUtf8Bytes: 1_048_576,
  maxDepth: 64,
  maxNodes: 100_000,
});

const MIN_PLAUSIBLE_EPOCH_SECONDS = 1_735_689_600; // 2025-01-01T00:00:00Z
const MAX_PLAUSIBLE_EPOCH_SECONDS = 4_102_444_800; // 2100-01-01T00:00:00Z

export class ReleasePolicyCanonicalError extends Error {
  constructor(readonly code: 'invalid_json' | 'json_too_large') {
    super(`Release policy canonicalization rejected: ${code}`);
    this.name = 'ReleasePolicyCanonicalError';
  }
}

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEpochSeconds = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= MIN_PLAUSIBLE_EPOCH_SECONDS &&
  value <= MAX_PLAUSIBLE_EPOCH_SECONDS;

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** RFC 8785 serialization with the Edge function's admission rules: only
 * plain JSON data (finite numbers, plain objects and arrays, no holes,
 * getters, symbols, cycles or exotic prototypes) inside its size limits. */
export function canonicalizeReleasePolicyJson(value: unknown): string {
  let nodes = 0;
  let stringUnits = 0;
  const ancestors = new Set<object>();

  const countString = (text: string): void => {
    stringUnits += text.length;
    if (stringUnits > RELEASE_POLICY_CANONICAL_JSON_LIMITS.maxUtf8Bytes) {
      throw new ReleasePolicyCanonicalError('json_too_large');
    }
  };

  const snapshot = (node: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (
      depth > RELEASE_POLICY_CANONICAL_JSON_LIMITS.maxDepth ||
      nodes > RELEASE_POLICY_CANONICAL_JSON_LIMITS.maxNodes
    ) {
      throw new ReleasePolicyCanonicalError('json_too_large');
    }
    if (typeof node === 'string') {
      countString(node);
      return node;
    }
    if (node === null || typeof node === 'boolean') return node;
    if (typeof node === 'number') {
      if (!Number.isFinite(node))
        throw new ReleasePolicyCanonicalError('invalid_json');
      return node;
    }
    if (typeof node !== 'object' || ancestors.has(node)) {
      throw new ReleasePolicyCanonicalError('invalid_json');
    }
    ancestors.add(node);
    let copy: JsonValue;
    if (Array.isArray(node)) {
      if (
        Object.getPrototypeOf(node) !== Array.prototype ||
        Reflect.ownKeys(node).length !== node.length + 1
      ) {
        throw new ReleasePolicyCanonicalError('invalid_json');
      }
      const array: JsonValue[] = [];
      for (let index = 0; index < node.length; index += 1) {
        const property = Object.getOwnPropertyDescriptor(node, String(index));
        if (!property || !('value' in property) || !property.enumerable) {
          throw new ReleasePolicyCanonicalError('invalid_json');
        }
        array.push(snapshot(property.value, depth + 1));
      }
      copy = array;
    } else {
      const prototype = Object.getPrototypeOf(node);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new ReleasePolicyCanonicalError('invalid_json');
      }
      const object: { [key: string]: JsonValue } = {};
      for (const key of Reflect.ownKeys(node)) {
        const property = Object.getOwnPropertyDescriptor(node, key);
        if (
          typeof key !== 'string' ||
          !property ||
          !('value' in property) ||
          !property.enumerable
        ) {
          throw new ReleasePolicyCanonicalError('invalid_json');
        }
        countString(key);
        object[key] = snapshot(property.value, depth + 1);
      }
      copy = object;
    }
    ancestors.delete(node);
    return copy;
  };

  const serialize = (node: JsonValue): string => {
    if (Array.isArray(node)) return `[${node.map(serialize).join(',')}]`;
    if (node !== null && typeof node === 'object') {
      return `{${Object.keys(node)
        .sort()
        .map(key => `${JSON.stringify(key)}:${serialize(node[key]!)}`)
        .join(',')}}`;
    }
    return JSON.stringify(node);
  };

  const serialized = serialize(snapshot(value, 0));
  if (
    utf8ByteLength(serialized) >
    RELEASE_POLICY_CANONICAL_JSON_LIMITS.maxUtf8Bytes
  ) {
    throw new ReleasePolicyCanonicalError('json_too_large');
  }
  return serialized;
}

export function digestReleasePolicyJson(value: unknown): string {
  return sha256Hex(canonicalizeReleasePolicyJson(value));
}

export interface VerifiedReleasePolicy {
  readonly document: AnalysisReleasePolicyDocument;
  readonly canonicalDocument: string;
  readonly approval: AnalysisReleaseApproval;
}

export type ReleaseAuthorityRejection =
  | 'malformed_envelope'
  | 'malformed_policy'
  | 'canonical_too_large'
  | 'version_mismatch'
  | 'canonical_mismatch'
  | 'digest_mismatch';

export type ReleasePolicyVerification =
  | { readonly ok: true; readonly policy: VerifiedReleasePolicy }
  | { readonly ok: false; readonly reason: ReleaseAuthorityRejection };

export type ReleaseAuthorityVerification =
  | {
      readonly ok: true;
      readonly policy: VerifiedReleasePolicy | null;
      readonly serverTime: number;
    }
  | { readonly ok: false; readonly reason: ReleaseAuthorityRejection };

/** Mirror of `readVerifiedReleasePolicy` in the Edge function: shape, byte
 * bound, version binding, recomputed canonical bytes, recomputed digest. */
export function verifyReleasePolicy(value: unknown): ReleasePolicyVerification {
  const reject = (reason: ReleaseAuthorityRejection) =>
    ({ ok: false, reason }) as const;
  if (!isRecord(value)) return reject('malformed_policy');
  const { document, canonicalDocument, approval } = value;
  if (
    !validateAnalysisReleasePolicy(document) ||
    typeof canonicalDocument !== 'string' ||
    !validateAnalysisReleaseApproval(approval)
  )
    return reject('malformed_policy');
  if (utf8ByteLength(canonicalDocument) > RELEASE_POLICY_MAX_CANONICAL_BYTES)
    return reject('canonical_too_large');
  if (approval.policy.version !== document.version)
    return reject('version_mismatch');
  let recomputed: string;
  try {
    recomputed = canonicalizeReleasePolicyJson(document);
  } catch {
    return reject('malformed_policy');
  }
  if (recomputed !== canonicalDocument) return reject('canonical_mismatch');
  if (sha256Hex(canonicalDocument) !== approval.policy.sha256)
    return reject('digest_mismatch');
  return { ok: true, policy: { document, canonicalDocument, approval } };
}

/** The route's 200 body. `policy: null` is the verified statement that no
 * policy is installed; anything the digest does not bind is no statement. */
export function verifyReleaseAuthorityResponse(
  body: unknown,
): ReleaseAuthorityVerification {
  if (
    !isRecord(body) ||
    body.schemaVersion !== RELEASE_AUTHORITY_SCHEMA_VERSION ||
    !isEpochSeconds(body.serverTime) ||
    !('policy' in body)
  )
    return { ok: false, reason: 'malformed_envelope' };
  if (body.policy === null)
    return { ok: true, policy: null, serverTime: body.serverTime };
  const verified = verifyReleasePolicy(body.policy);
  if (!verified.ok) return verified;
  return { ok: true, policy: verified.policy, serverTime: body.serverTime };
}

export type ReleaseIneligibilityReason = Extract<
  AnalysisReleaseEligibility,
  { status: 'ineligible' }
>['reasonCode'];

export type ReleasePolicyAdmission =
  | { readonly status: 'active'; readonly policy: VerifiedReleasePolicy }
  | {
      readonly status: 'ineligible';
      readonly reasonCode: ReleaseIneligibilityReason;
    };

/** Policy-level admission at `nowEpochSeconds`, the same shared eligibility
 * rules the Edge function's `admitChargeableRelease` applies: evaluated for a
 * real, intent-confirmed observation inside the policy's own supported domain
 * so only approval, withdrawal and validity can reject. */
export function admitReleasePolicy(
  policy: VerifiedReleasePolicy | null,
  nowEpochSeconds: number,
): ReleasePolicyAdmission {
  if (!policy) return { status: 'ineligible', reasonCode: 'unverified' };
  const eligibility = resolveAnalysisReleaseEligibility(
    policy.document,
    policy.approval,
    {
      ...policy.document.supportedInputs[0],
      source: 'real',
      intentConfirmed: true,
    },
    nowEpochSeconds,
  );
  if (eligibility.status === 'eligible') return { status: 'active', policy };
  return { status: 'ineligible', reasonCode: eligibility.reasonCode };
}

export interface ReleasePolicyCacheScope {
  readonly ownerKey: string;
  readonly apiOrigin: string;
}

function cacheBinding(scope: ReleasePolicyCacheScope): string {
  return sha256Hex(
    `${RELEASE_POLICY_CACHE_SCHEMA_VERSION}\n${scope.ownerKey}\n${scope.apiOrigin}`,
  );
}

export type CachedReleasePolicyVerdict =
  | {
      readonly status: 'active';
      readonly policy: VerifiedReleasePolicy;
      readonly fetchedAt: number;
    }
  | {
      readonly status: 'unavailable';
      readonly reason:
        'missing' | 'invalid' | 'expired' | 'reconcile_required' | 'ineligible';
    };

/** Stores a verified policy that is active at `serverTime`. Returns `false`
 * — and stores nothing — for anything else or anything over the bounds. */
export async function writeCachedReleasePolicy(
  db: LocalDb,
  scope: ReleasePolicyCacheScope,
  verified: {
    readonly policy: VerifiedReleasePolicy;
    readonly serverTime: number;
  },
): Promise<boolean> {
  if (!isEpochSeconds(verified.serverTime)) return false;
  const checked = verifyReleasePolicy(verified.policy);
  if (!checked.ok) return false;
  if (
    admitReleasePolicy(checked.policy, verified.serverTime).status !== 'active'
  )
    return false;
  const record = JSON.stringify({
    schemaVersion: RELEASE_POLICY_CACHE_SCHEMA_VERSION,
    binding: cacheBinding(scope),
    fetchedAt: verified.serverTime,
    policy: checked.policy,
  });
  if (utf8ByteLength(record) > RELEASE_POLICY_CACHE_MAX_BYTES) return false;
  await setKv(db, releasePolicyCacheKeyForOwner(scope.ownerKey), record);
  return true;
}

export async function clearCachedReleasePolicy(
  db: LocalDb,
  scope: ReleasePolicyCacheScope,
): Promise<void> {
  await db.execute(`DELETE FROM kv WHERE key = ?`, [
    releasePolicyCacheKeyForOwner(scope.ownerKey),
  ]);
}

/** The cached policy for this account + origin, re-verified byte for byte,
 * and only while the trusted clock proves it inside its validity window and
 * the cache lifetime. Uncertain time (no anchor, a floor, an unmeasured
 * interval, a rollback) authorizes nothing. */
export async function readCachedReleasePolicy(
  db: LocalDb,
  scope: ReleasePolicyCacheScope,
  reading: TrustedTimeReading,
): Promise<CachedReleasePolicyVerdict> {
  const raw = await getKv(db, releasePolicyCacheKeyForOwner(scope.ownerKey));
  if (raw === null) return { status: 'unavailable', reason: 'missing' };
  if (utf8ByteLength(raw) > RELEASE_POLICY_CACHE_MAX_BYTES)
    return { status: 'unavailable', reason: 'invalid' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'unavailable', reason: 'invalid' };
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== RELEASE_POLICY_CACHE_SCHEMA_VERSION ||
    typeof parsed.binding !== 'string' ||
    !isEpochSeconds(parsed.fetchedAt)
  )
    return { status: 'unavailable', reason: 'invalid' };
  if (parsed.binding !== cacheBinding(scope))
    return { status: 'unavailable', reason: 'missing' };
  const verified = verifyReleasePolicy(parsed.policy);
  if (!verified.ok) return { status: 'unavailable', reason: 'invalid' };
  const { policy } = verified;
  const fetchedAt = parsed.fetchedAt;
  const issuedAtMs = fetchedAt * 1000;
  const withdrawnAtMs =
    typeof policy.approval.withdrawnAt === 'number'
      ? policy.approval.withdrawnAt * 1000
      : Number.POSITIVE_INFINITY;
  const expiresAtMs = Math.min(
    policy.document.validUntil * 1000,
    withdrawnAtMs,
    issuedAtMs + RELEASE_POLICY_CACHE_MAX_AGE_MS,
  );
  if (!(expiresAtMs > issuedAtMs))
    return { status: 'unavailable', reason: 'expired' };
  const lease = evaluateLease({ issuedAtMs, expiresAtMs }, reading);
  if (lease.kind === 'expired')
    return { status: 'unavailable', reason: 'expired' };
  if (lease.kind === 'reconcile_required')
    return { status: 'unavailable', reason: 'reconcile_required' };
  const admission = admitReleasePolicy(
    policy,
    Math.floor(reading.nowMs / 1000),
  );
  if (admission.status !== 'active')
    return {
      status: 'unavailable',
      reason: admission.reasonCode === 'expired' ? 'expired' : 'ineligible',
    };
  return { status: 'active', policy, fetchedAt };
}

export type ReleaseAuthorityAdmission =
  | {
      readonly status: 'active';
      readonly policy: VerifiedReleasePolicy;
      readonly source: 'server' | 'cache';
    }
  | {
      readonly status: 'ineligible';
      readonly reasonCode: ReleaseIneligibilityReason;
    }
  | {
      readonly status: 'unavailable';
      readonly reason:
        | 'rejected_response'
        | Extract<
            CachedReleasePolicyVerdict,
            { status: 'unavailable' }
          >['reason'];
      readonly error: unknown;
    };

export interface ReleaseAuthorityGate {
  readonly db: LocalDb;
  readonly scope: ReleasePolicyCacheScope;
  readonly client: ReleasePolicyClient;
  readonly readTrustedTime?: () => Promise<TrustedTimeReading>;
}

/**
 * Server first: a verified answer is final for this run — an active policy
 * is admitted and cached, a verified refusal (no policy, withdrawn, denied,
 * expired, unreleased) is `ineligible` and evicts whatever was cached. A body
 * the digest does not bind, a transport failure or an HTTP error is no
 * verdict: the verified cache decides, and without one the run is
 * `unavailable` — retryable, never a charge, never a settled refusal. An
 * authentication refusal (no signed-in session, 401/403) is neither: it is
 * rethrown so the caller reports it exactly as a refused reservation.
 */
export async function resolveReleaseAuthority(
  gate: ReleaseAuthorityGate,
): Promise<ReleaseAuthorityAdmission> {
  let failure: unknown = null;
  let rejected = false;
  try {
    const verified = verifyReleaseAuthorityResponse(await gate.client.read());
    if (verified.ok) {
      const admission = admitReleasePolicy(
        verified.policy,
        verified.serverTime,
      );
      if (admission.status === 'active') {
        await writeCachedReleasePolicy(gate.db, gate.scope, {
          policy: admission.policy,
          serverTime: verified.serverTime,
        }).catch(() => false);
        return { status: 'active', policy: admission.policy, source: 'server' };
      }
      await clearCachedReleasePolicy(gate.db, gate.scope).catch(() => {});
      return admission;
    }
    rejected = true;
    failure = verified.reason;
  } catch (error) {
    if (isAuthenticationRefusal(error)) throw error;
    failure = error;
  }
  const readTrustedTime = gate.readTrustedTime ?? (() => trustedTime.read());
  let cached: CachedReleasePolicyVerdict;
  try {
    cached = await readCachedReleasePolicy(
      gate.db,
      gate.scope,
      await readTrustedTime(),
    );
  } catch (error) {
    return { status: 'unavailable', reason: 'invalid', error };
  }
  if (cached.status === 'active')
    return { status: 'active', policy: cached.policy, source: 'cache' };
  return {
    status: 'unavailable',
    reason:
      rejected && cached.reason === 'missing'
        ? 'rejected_response'
        : cached.reason,
    error: failure,
  };
}

function isAuthenticationRefusal(error: unknown): error is ApiError {
  return (
    error instanceof ApiError && (error.status === 401 || error.status === 403)
  );
}

/** The typed refusal the reservation path already understands as the
 * authority's settled answer (mechanics-only partial, nothing chargeable). */
export function releaseNotAuthorizedRefusal(): ApiError {
  return new ApiError(
    409,
    RELEASE_NOT_AUTHORIZED_CODE,
    RELEASE_NOT_AUTHORIZED_MESSAGE,
  );
}

/** A transport-class failure: the run ends `unavailable` and can be scored
 * later, exactly as when the rating service itself cannot be reached. */
export function releaseAuthorityUnavailable(): ApiError {
  return new ApiError(
    503,
    'access.release_authority_unavailable',
    'The rating service could not be reached. Your capture is saved and can be scored later.',
  );
}

/** Resolves only for an active policy; throws the typed refusal for a
 * verified negative and the transport-class error for unknown state. */
export async function requireReleaseAuthority(
  gate: ReleaseAuthorityGate,
): Promise<VerifiedReleasePolicy> {
  const admission = await resolveReleaseAuthority(gate);
  if (admission.status === 'active') return admission.policy;
  if (admission.status === 'ineligible') throw releaseNotAuthorizedRefusal();
  throw releaseAuthorityUnavailable();
}
