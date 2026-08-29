/**
 * Typed security-monitoring events (workstream i25). Every event is a member
 * of the SecurityEvent union or it does not get recorded — no free-form
 * blobs. Events carry route TEMPLATES, methods, status codes, and typed error
 * codes only: never URLs with concrete identifiers, request bodies, tokens,
 * emails, or user identity. Redaction is enforced structurally (allowlisted
 * fields) and verified by findSecurityEventViolations, which the test suite
 * runs against every recorded event.
 */

export type SecurityEventKind =
  | "auth_anomaly"
  | "authz_denial"
  | "admin_anomaly"
  | "upload_abuse"
  | "rate_limit_trip"
  | "media_access_failure"
  | "db_privilege_anomaly"
  | "consent_mutation_denied"
  | "training_eligibility_change";

interface SecurityEventBase {
  /** Event timestamp, ISO-8601. */
  at: string;
  /** Fastify request id (x-request-id) — correlates with the API access log. */
  requestId: string;
  /** Route TEMPLATE (e.g. "/v1/media/:id"), never the concrete URL. */
  route: string;
  method: string;
  statusCode: number;
  /** Typed error code from the failure envelope; "none" for 2xx events. */
  errorCode: string;
}

export type SecurityEvent = SecurityEventBase &
  (
    | { kind: "auth_anomaly" }
    | { kind: "authz_denial" }
    | { kind: "admin_anomaly" }
    | { kind: "upload_abuse" }
    | { kind: "rate_limit_trip" }
    | { kind: "media_access_failure" }
    | {
        kind: "db_privilege_anomaly";
        /** Postgres SQLSTATE class that signalled the privilege anomaly. */
        pgCode: string;
      }
    | { kind: "consent_mutation_denied" }
    | {
        kind: "training_eligibility_change";
        /** Which mutation surface changed eligibility-relevant consent. */
        surface: "consent_ledger" | "privacy_center";
      }
  );

export interface ISecurityEventSink {
  record(event: SecurityEvent): void;
}

/** Test/ops sink that retains events in memory for inspection. */
export class InMemorySecurityEventSink implements ISecurityEventSink {
  readonly events: SecurityEvent[] = [];
  record(event: SecurityEvent): void {
    this.events.push(event);
  }
}

/**
 * Postgres SQLSTATEs that indicate the API's database role attempted
 * something it is not granted (42501 insufficient_privilege) or presented a
 * bad/mis-scoped credential (28000 invalid_authorization_specification,
 * 28P01 invalid_password). Any of these firing at runtime means the
 * least-privilege role setup drifted — a P0 signal, never routine.
 */
export const PG_PRIVILEGE_ANOMALY_CODES = new Set(["42501", "28000", "28P01"]);

/** Consent-ledger mutation routes (eligibility source of truth). */
const CONSENT_MUTATION_ROUTES = new Set([
  "POST /v1/me/consent/grant",
  "POST /v1/me/consent/withdraw",
]);

/** Privacy-center surface that also mutates training eligibility. */
const PRIVACY_CENTER_CONSENT_ROUTES = new Set(["PUT /v1/me/ml-training-consent"]);

/** Upload-path routes where 4xx traffic is the abuse signal. */
const UPLOAD_ROUTES = new Set(["POST /v1/media/uploads", "POST /v1/media/:id/complete"]);

/** Media read/delete routes where failures indicate probing or purge races. */
const MEDIA_ACCESS_ROUTES = new Set(["GET /v1/media/:id", "DELETE /v1/media/:id"]);

export interface SecurityClassifierInput {
  at: string;
  requestId: string;
  /** Route template; callers pass "unmatched" when Fastify found no route. */
  route: string;
  method: string;
  statusCode: number;
  /** Typed error code from sendFailure, if the reply carried one. */
  errorCode: string | undefined;
}

/**
 * Maps a finished request onto the security event it represents, or null for
 * requests with no security significance. Precedence is most-specific first:
 * a 429 on an upload route is a rate-limit trip, not upload abuse; a 403 on
 * an admin route is an admin anomaly, not a generic authorization denial.
 */
export function classifySecurityEvent(input: SecurityClassifierInput): SecurityEvent | null {
  const { at, requestId, route, method, statusCode } = input;
  const errorCode = input.errorCode ?? "none";
  const routeKey = `${method} ${route}`;
  const base: SecurityEventBase = { at, requestId, route, method, statusCode, errorCode };

  if (statusCode === 429) return { ...base, kind: "rate_limit_trip" };

  const isConsentMutation = CONSENT_MUTATION_ROUTES.has(routeKey);
  const isPrivacyCenterConsent = PRIVACY_CENTER_CONSENT_ROUTES.has(routeKey);
  if (statusCode >= 200 && statusCode < 300 && (isConsentMutation || isPrivacyCenterConsent)) {
    return {
      ...base,
      kind: "training_eligibility_change",
      surface: isConsentMutation ? "consent_ledger" : "privacy_center",
    };
  }
  if (statusCode < 400 || statusCode >= 500) return null;

  if (isConsentMutation || isPrivacyCenterConsent) {
    return { ...base, kind: "consent_mutation_denied" };
  }
  if (route.startsWith("/v1/admin/") && (statusCode === 401 || statusCode === 403)) {
    return { ...base, kind: "admin_anomaly" };
  }
  if (errorCode === "auth.admin_not_authorized" || errorCode === "auth.admin_required") {
    return { ...base, kind: "admin_anomaly" };
  }
  if (UPLOAD_ROUTES.has(routeKey) && statusCode !== 401 && statusCode !== 403) {
    return { ...base, kind: "upload_abuse" };
  }
  if (MEDIA_ACCESS_ROUTES.has(routeKey)) {
    return { ...base, kind: "media_access_failure" };
  }
  if (statusCode === 401) return { ...base, kind: "auth_anomaly" };
  if (statusCode === 403) return { ...base, kind: "authz_denial" };
  return null;
}

/** Field names allowed on a security event — anything else is a violation. */
const ALLOWED_EVENT_KEYS = new Set([
  "kind",
  "at",
  "requestId",
  "route",
  "method",
  "statusCode",
  "errorCode",
  "pgCode",
  "surface",
]);

/** Bearer/JWT material: three base64url segments joined by dots. */
const JWT_PATTERN = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/;
/** Email addresses are PII and never belong in a security event. */
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/;
/** Long hex strings look like tokens, secrets, or credential fingerprints. */
const LONG_HEX_PATTERN = /\b[0-9a-fA-F]{40,}\b/;
/** Authorization header values must never be copied into an event. */
const BEARER_PATTERN = /\bBearer\s+\S+/i;
/** Concrete UUIDs in the route mean a raw URL leaked in place of a template. */
const UUID_IN_ROUTE_PATTERN =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/**
 * Returns human-readable violations if an event carries secrets, PII, or
 * non-allowlisted fields. Empty array = clean. The test suite runs this
 * against every event produced by the detectors.
 */
export function findSecurityEventViolations(event: SecurityEvent): string[] {
  const violations: string[] = [];
  for (const [key, value] of Object.entries(event)) {
    if (!ALLOWED_EVENT_KEYS.has(key)) {
      violations.push(`disallowed field "${key}"`);
      continue;
    }
    if (typeof value !== "string") continue;
    if (JWT_PATTERN.test(value)) violations.push(`field "${key}" contains JWT-like material`);
    if (EMAIL_PATTERN.test(value)) violations.push(`field "${key}" contains an email address`);
    if (LONG_HEX_PATTERN.test(value)) violations.push(`field "${key}" contains a long hex secret`);
    if (BEARER_PATTERN.test(value)) violations.push(`field "${key}" contains a bearer credential`);
  }
  if (UUID_IN_ROUTE_PATTERN.test(event.route)) {
    violations.push('field "route" contains a concrete UUID instead of a route template');
  }
  return violations;
}
