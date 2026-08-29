/**
 * Support diagnostics (directive §45): privacy-limited "why did this analysis
 * fail" projection for the audited admin support tool. The report is built
 * exclusively from an explicit field allowlist — never raw media, storage
 * coordinates, push tokens, or account identity beyond the pseudonymous
 * user id the admin already holds.
 */

export type SupportFailureCategory =
  | "none"
  | "in_queue"
  | "in_progress"
  | "cancelled"
  | "cloud_model_unavailable"
  | "media"
  | "validation"
  | "quota"
  | "pipeline"
  | "unclassified";

/**
 * Derive a coarse support-facing failure category from server job state plus
 * the machine failure code. Unknown codes map to "unclassified" — the tool
 * reports honest uncertainty rather than guessing.
 */
export function categorizeAnalysisFailure(
  status: string,
  failureCode: string | null,
): SupportFailureCategory {
  if (status === "complete") return "none";
  if (status === "queued") return "in_queue";
  if (status === "processing") return "in_progress";
  if (status === "cancelled") return "cancelled";
  if (status !== "failed") return "unclassified";
  if (failureCode === null) return "unclassified";
  if (failureCode === "analysis.cloud_model_unavailable") return "cloud_model_unavailable";
  if (failureCode.startsWith("media.")) return "media";
  if (failureCode.startsWith("validation.")) return "validation";
  if (failureCode.startsWith("access.") || failureCode.startsWith("billing.")) return "quota";
  if (failureCode.startsWith("analysis.")) return "pipeline";
  return "unclassified";
}

export interface SupportLatency {
  queueMs: number | null;
  processingMs: number | null;
  totalMs: number | null;
}

function diffMs(from: Date | null, to: Date | null): number | null {
  if (from === null || to === null) return null;
  const delta = to.getTime() - from.getTime();
  return Number.isFinite(delta) ? delta : null;
}

/** Latency from server job timestamps; every leg is null until it happened. */
export function computeLatency(
  requestedAt: Date | null,
  startedAt: Date | null,
  finishedAt: Date | null,
): SupportLatency {
  return {
    queueMs: diffMs(requestedAt, startedAt),
    processingMs: diffMs(startedAt, finishedAt),
    totalMs: diffMs(requestedAt, finishedAt),
  };
}

/** The only version-vector keys the diagnostics report may echo. */
export const PIPELINE_VERSION_KEYS = [
  "appVersion",
  "modelBundleVersion",
  "poseModelVersion",
  "paddleModelVersion",
  "strokeDetectorVersion",
  "phaseModelVersion",
  "scoringModelVersion",
  "shotConfigVersion",
] as const;

export type PipelineVersionKey = (typeof PIPELINE_VERSION_KEYS)[number];

/**
 * Project a stored shot version_vector down to the allowlisted version keys.
 * Anything that is not a string under an allowlisted key is dropped, so a
 * polluted vector can never smuggle other payload into the report.
 */
export function projectPipelineVersions(
  versionVector: unknown,
): Partial<Record<PipelineVersionKey, string>> {
  const projected: Partial<Record<PipelineVersionKey, string>> = {};
  if (typeof versionVector !== "object" || versionVector === null) return projected;
  const record = versionVector as Record<string, unknown>;
  for (const key of PIPELINE_VERSION_KEYS) {
    const value = record[key];
    if (typeof value === "string") projected[key] = value;
  }
  return projected;
}

/**
 * Key names that must never appear anywhere in a diagnostics payload:
 * storage coordinates and raw-media pointers, credentials, and direct
 * account identity (policy: pseudonymous user id only).
 */
export const FORBIDDEN_DIAGNOSTIC_KEYS = [
  "bucket",
  "objectKey",
  "object_key",
  "sha256",
  "encryptionKeyId",
  "encryption_key_id",
  "pushToken",
  "push_token",
  "email",
  "displayName",
  "display_name",
  "handle",
] as const;

/** Deep scan for forbidden keys; used by tests to enforce the redaction contract. */
export function findForbiddenKeys(payload: unknown, path = "$"): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  if (Array.isArray(payload)) {
    return payload.flatMap((entry, index) => findForbiddenKeys(entry, `${path}[${index}]`));
  }
  const found: string[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if ((FORBIDDEN_DIAGNOSTIC_KEYS as readonly string[]).includes(key)) {
      found.push(`${path}.${key}`);
    }
    found.push(...findForbiddenKeys(value, `${path}.${key}`));
  }
  return found;
}

export type AnalysisJobDiagnosticsRow = {
  id: string;
  user_id: string;
  status: string;
  inference_mode: string;
  failure_code: string | null;
  requested_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  has_media: boolean;
  media_status: string | null;
  has_session: boolean;
  permit_status: string | null;
  permit_outcome: string | null;
  shot_result_kind: string | null;
  shot_version_vector: unknown;
};

export type DeviceDiagnosticsRow = {
  platform: string;
  app_version: string | null;
  os_version: string | null;
  model: string | null;
  device_tier: string | null;
  model_bundle_version: string | null;
};

export interface SupportAnalysisDiagnostics {
  analysisId: string;
  userId: string;
  serverJobState: string;
  inferenceMode: string;
  failureCode: string | null;
  failureCategory: SupportFailureCategory;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  latency: SupportLatency;
  hasMedia: boolean;
  mediaStatus: string | null;
  hasSession: boolean;
  permit: { status: string | null; outcome: string | null };
  shotResultKind: string | null;
  pipelineVersions: Partial<Record<PipelineVersionKey, string>>;
  device: {
    platform: string;
    appVersion: string | null;
    osVersion: string | null;
    model: string | null;
    deviceTier: string | null;
    modelBundleVersion: string | null;
  } | null;
}

/** Assemble the allowlisted diagnostics report from the queried rows. */
export function buildSupportDiagnostics(
  job: AnalysisJobDiagnosticsRow,
  device: DeviceDiagnosticsRow | null,
): SupportAnalysisDiagnostics {
  return {
    analysisId: job.id,
    userId: job.user_id,
    serverJobState: job.status,
    inferenceMode: job.inference_mode,
    failureCode: job.failure_code,
    failureCategory: categorizeAnalysisFailure(job.status, job.failure_code),
    requestedAt: job.requested_at.toISOString(),
    startedAt: job.started_at?.toISOString() ?? null,
    finishedAt: job.finished_at?.toISOString() ?? null,
    latency: computeLatency(job.requested_at, job.started_at, job.finished_at),
    hasMedia: job.has_media,
    mediaStatus: job.media_status,
    hasSession: job.has_session,
    permit: { status: job.permit_status, outcome: job.permit_outcome },
    shotResultKind: job.shot_result_kind,
    pipelineVersions: projectPipelineVersions(job.shot_version_vector),
    device:
      device === null
        ? null
        : {
            platform: device.platform,
            appVersion: device.app_version,
            osVersion: device.os_version,
            model: device.model,
            deviceTier: device.device_tier,
            modelBundleVersion: device.model_bundle_version,
          },
  };
}
