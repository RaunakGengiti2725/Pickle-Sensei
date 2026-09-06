export const ANALYSIS_PLAN_VERSION = "analysis-plan-3d-validation-1" as const;

export interface AnalysisPlanContext {
  platform: string;
  osMajorVersion: number;
  isDevelopmentBuild: boolean;
  nativeReconstructionAvailable: boolean;
}

export type AnalysisPlan =
  | Readonly<{
      engine: "legacy_2d";
      policyVersion: typeof ANALYSIS_PLAN_VERSION;
      reason:
        | "unsupported_platform"
        | "unsupported_os"
        | "3d_release_not_approved"
        | "native_reconstruction_unavailable";
    }>
  | Readonly<{
      engine: "motion_3d";
      policyVersion: typeof ANALYSIS_PLAN_VERSION;
      purpose: "development_validation";
      providerId: "pose.apple-vision-3d";
      permits: "none";
      scoring: "blocked";
      fallbackAfterFailure: false;
    }>;

export function resolveAnalysisPlan(context: AnalysisPlanContext): AnalysisPlan {
  let reason: Extract<AnalysisPlan, { engine: "legacy_2d" }>["reason"] | null = null;
  if (context.platform !== "ios") reason = "unsupported_platform";
  else if (!Number.isInteger(context.osMajorVersion) || context.osMajorVersion < 17)
    reason = "unsupported_os";
  else if (!context.isDevelopmentBuild) reason = "3d_release_not_approved";
  else if (!context.nativeReconstructionAvailable) reason = "native_reconstruction_unavailable";

  return reason
    ? Object.freeze({ engine: "legacy_2d", policyVersion: ANALYSIS_PLAN_VERSION, reason })
    : Object.freeze({
        engine: "motion_3d",
        policyVersion: ANALYSIS_PLAN_VERSION,
        purpose: "development_validation",
        providerId: "pose.apple-vision-3d",
        permits: "none",
        scoring: "blocked",
        fallbackAfterFailure: false,
      });
}
