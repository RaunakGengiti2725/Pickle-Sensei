/**
 * Support diagnostics types mirroring the API's privacy-limited report
 * (GET /v1/admin/support/analyses/:id). Allowlisted fields only — the API
 * never sends raw media, storage coordinates, or account identity beyond
 * the pseudonymous user id.
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

export interface SupportLatency {
  queueMs: number | null;
  processingMs: number | null;
  totalMs: number | null;
}

export interface SupportDeviceInfo {
  platform: string;
  appVersion: string | null;
  osVersion: string | null;
  model: string | null;
  deviceTier: string | null;
  modelBundleVersion: string | null;
}

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
  pipelineVersions: Record<string, string>;
  device: SupportDeviceInfo | null;
}

export interface SupportAnalysisListEntry {
  analysisId: string;
  serverJobState: string;
  inferenceMode: string;
  failureCode: string | null;
  failureCategory: SupportFailureCategory;
  requestedAt: string;
  latency: SupportLatency;
}
