// Pure decision layer for the two server-verified billing paths
// (POST /webhooks/revenuecat and POST /v1/billing/sync).
//
// The routes in index.ts own I/O; every judgement they make about a
// RevenueCat response, a PostgREST failure, or a subject identifier is made
// here so the same rule cannot drift between the webhook and the sync route,
// and so each rule is testable without a fake server. Nothing in this module
// reads Deno.env or touches the network: it cannot log a secret it never sees.

/** The shape of a PostgREST/`postgres-js` error as surfaced by supabase-js. */
export interface PostgrestFailureLike {
  code?: string | null;
  message?: string | null;
}

/** SQLSTATE 23503 — foreign_key_violation. billing_entitlements.user_id
 * references the profiles row a user only gets on bootstrap, so a webhook for
 * someone who has never signed in cannot be persisted no matter how often
 * RevenueCat redelivers it. It is the ONLY permanent persist failure: every
 * other code (57P03 starting up, 40001 serialization, 42501 missing grant,
 * 08006 connection loss, PGRST timeouts, …) either clears by itself or needs
 * an operator, and both are served by asking for a redelivery. */
const FK_VIOLATION = "23503";

export type PersistDisposition =
  /** The subject has no profiles row yet; retrying can never help. */
  | "subject_not_bootstrapped"
  /** Unknown/transient: the delivery must be retried, not acknowledged. */
  | "retryable";

export function classifyPersistFailure(failure: PostgrestFailureLike): PersistDisposition {
  return failure.code === FK_VIOLATION ? "subject_not_bootstrapped" : "retryable";
}

/** Canonical (lowercase) form of one of our account uuids, or null when the
 * value is not one. RevenueCat app_user_ids are case-SENSITIVE while Postgres
 * `uuid` folds case, so an uppercase-hex subject would query one RevenueCat
 * identity and write a different account's row: canonicalising here keeps the
 * identity we read equal to the row we write. */
const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function canonicalSubjectId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lowered = value.toLowerCase();
  return CANONICAL_UUID_RE.test(lowered) ? lowered : null;
}

/** Canonical subject ids inside an event array (aliases, transferred_from,
 * transferred_to), skipping anything that is not one of our uuids. */
export function canonicalSubjectIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    const id = canonicalSubjectId(entry);
    if (id) ids.push(id);
  }
  return ids;
}

export type RevenueCatFailure =
  | { kind: "unconfigured" }
  | { kind: "status"; status: number; body: string }
  | { kind: "transport"; error: unknown };

/** One log line naming WHY a RevenueCat read failed. Built from the upstream
 * status, RevenueCat's numeric error code and the error's name only — the
 * response body and the API key are never echoed, so a rotated key produces a
 * diagnosable outage instead of a leak. */
export function revenueCatFailureDiagnostic(failure: RevenueCatFailure): string {
  const prefix = "[api] revenuecat subscriber read failed:";
  if (failure.kind === "unconfigured") {
    return `${prefix} no REVENUECAT_SECRET_API_KEY/REVENUECAT_PUBLIC_SDK_KEY configured`;
  }
  if (failure.kind === "transport") {
    const error = failure.error;
    const name = error instanceof Error ? error.name : typeof error;
    return `${prefix} transport error ${name}`;
  }
  const code = revenueCatErrorCode(failure.body);
  const suffix = code === null ? "" : ` (revenuecat code ${code})`;
  return `${prefix} HTTP ${failure.status}${suffix}`;
}

/** RevenueCat error envelopes carry a numeric `code` (e.g. 7225 = invalid API
 * key). Only that number is extracted; a non-numeric or absent code yields
 * null so no upstream text can reach the logs. */
function revenueCatErrorCode(body: string): number | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const code = (parsed as Record<string, unknown>).code;
      if (typeof code === "number" && Number.isFinite(code)) return code;
    }
  } catch {
    // Non-JSON error bodies (gateway HTML) carry no code worth logging.
  }
  return null;
}
