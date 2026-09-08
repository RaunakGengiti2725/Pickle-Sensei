import {
  resolveAnalysisReleaseEligibility,
  validateAnalysisReleasePolicy,
  validateAnalysisReleaseApproval,
  type AnalysisReleaseApproval,
  type AnalysisReleasePolicyDocument,
  type ObservedAnalysisReleaseInput,
} from "../../../packages/shared-types/src/analysisReleasePolicy.ts";
import type { AnalysisReleaseEligibility } from "../../../packages/shared-types/src/analysisOutcome.ts";
import { canonicalizeOfflineJson, digestCanonicalOfflineJson } from "./canonicalDigest.ts";

export class ReleasePolicyError extends Error {
  /** `storage`: the authority could not be read (transport/RPC failure —
   * retryable). `integrity`: it was read but cannot be trusted (malformed,
   * tampered, digest or lineage mismatch — never authorization). */
  constructor(
    readonly failure: "storage" | "integrity" = "integrity",
    cause?: unknown,
  ) {
    super("Release authority could not be verified.", cause === undefined ? {} : { cause });
    this.name = "ReleasePolicyError";
  }
}
export interface VerifiedReleasePolicy {
  document: AnalysisReleasePolicyDocument;
  canonicalDocument: string;
  approval: AnalysisReleaseApproval;
}
type PolicyReader = () => PromiseLike<{ data: unknown; error: unknown }>;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Uncached authority read. Runtime deployments cannot approve this table.
 * Both RFC8785 canonical bytes and their independently computed digest must
 * match before callers can resolve eligibility or issue a signed grant. */
export async function readVerifiedReleasePolicy(
  read: PolicyReader,
): Promise<VerifiedReleasePolicy | null> {
  const response = await read();
  if (response.error) throw new ReleasePolicyError("storage", response.error);
  if (!record(response.data)) throw new ReleasePolicyError();
  const value = response.data;
  if (value.document === null && value.approval === null && value.denyNewAuthorizations === true)
    return null;
  if (
    !validateAnalysisReleasePolicy(value.document) ||
    typeof value.canonicalDocument !== "string" ||
    new TextEncoder().encode(value.canonicalDocument).byteLength > 65536 ||
    !validateAnalysisReleaseApproval(value.approval) ||
    typeof value.denyNewAuthorizations !== "boolean" ||
    value.approval.denyNewAuthorizations !== value.denyNewAuthorizations ||
    !record(value.approval.policy) ||
    value.approval.policy.version !== value.document.version ||
    canonicalizeOfflineJson(value.document) !== value.canonicalDocument ||
    (await digestCanonicalOfflineJson(value.document)) !== value.approval.policy.sha256
  )
    throw new ReleasePolicyError();
  return {
    document: value.document,
    canonicalDocument: value.canonicalDocument,
    approval: value.approval,
  };
}

export function eligibilityForVerifiedRelease(
  policy: VerifiedReleasePolicy | null,
  input: ObservedAnalysisReleaseInput,
  nowEpochSeconds: number,
): AnalysisReleaseEligibility {
  return resolveAnalysisReleaseEligibility(
    policy?.document,
    policy?.approval,
    input,
    nowEpochSeconds,
  );
}

export type ReleaseIneligibilityReason = Extract<
  AnalysisReleaseEligibility,
  { status: "ineligible" }
>["reasonCode"];

/** Verdict on whether a chargeable scored run may be admitted right now.
 *  - `active`: a verified, approved, non-withdrawn policy inside its validity
 *    window is installed; the chargeable path may proceed.
 *  - `ineligible`: no policy, withdrawn, deny-new-authorizations, unreleased,
 *    expired, or the stored authority fails integrity. A typed, final,
 *    non-chargeable verdict — never a 5xx.
 *  - `unavailable`: the authority could not be read at all. Retryable and
 *    equally non-chargeable; unknown state is never authorization. */
export type ChargeableReleaseAdmission =
  | { status: "active"; policy: VerifiedReleasePolicy }
  | { status: "ineligible"; reasonCode: ReleaseIneligibilityReason }
  | { status: "unavailable"; error: unknown };

/** Policy-level admission, independent of any one shot: the same shared
 * eligibility rules (`resolveAnalysisReleaseEligibility`) are evaluated for a
 * real, intent-confirmed observation inside the policy's own supported domain
 * (validation guarantees at least one), so only lineage/approval/withdrawal/
 * validity can reject. Per-observation domain checks remain the analyzer's
 * and the mobile publication gate's job. */
export function admitChargeableRelease(
  policy: VerifiedReleasePolicy | null,
  nowEpochSeconds: number,
): ChargeableReleaseAdmission {
  if (!policy) return { status: "ineligible", reasonCode: "unverified" };
  const eligibility = eligibilityForVerifiedRelease(
    policy,
    { ...policy.document.supportedInputs[0], source: "real", intentConfirmed: true },
    nowEpochSeconds,
  );
  if (eligibility.status === "eligible") return { status: "active", policy };
  return { status: "ineligible", reasonCode: eligibility.reasonCode };
}

/** Uncached read + admission in one step for the edge charge paths. A
 * withdrawal must take effect on the next request, so nothing here is
 * memoized across requests. */
export async function readChargeableReleaseAdmission(
  read: PolicyReader,
  nowEpochSeconds: number,
): Promise<ChargeableReleaseAdmission> {
  try {
    return admitChargeableRelease(await readVerifiedReleasePolicy(read), nowEpochSeconds);
  } catch (error) {
    if (error instanceof ReleasePolicyError) {
      if (error.failure === "integrity") return { status: "ineligible", reasonCode: "unverified" };
      return { status: "unavailable", error: error.cause ?? error };
    }
    return { status: "unavailable", error };
  }
}
