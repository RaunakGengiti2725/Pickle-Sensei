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
  constructor() {
    super("Release authority could not be verified.");
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
  if (response.error || !record(response.data)) throw new ReleasePolicyError();
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
