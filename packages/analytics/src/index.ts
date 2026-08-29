import type { CheckpointKey, ShotTypeSlug } from "@pickle/shared-types";

/**
 * Strongly-typed analytics events — the spec's exact taxonomy (spec p. 43).
 * Rules (directive §37): never raw video, never sensitive biomechanical data,
 * never free-form blobs. Every event is a member of this union or it does not
 * get sent.
 */

interface Base {
  /** Client event timestamp, ISO-8601. */
  at: string;
  sessionId?: string;
  /** App marketing version + build number, e.g. "1.4.0 (312)". */
  appBuild?: string;
  platform?: "ios" | "android" | "service";
  /**
   * Coarse hardware tier only ("phone_high" | "phone_mid" | "phone_low" |
   * "tablet" | "server") — never a device identifier, serial, or IDFA/AAID.
   */
  deviceClass?: string;
}

/**
 * Why analysis abstained instead of producing a result. Categories only —
 * the fine-grained machine reason codes stay in the on-device evidence
 * record, never in analytics.
 */
export type AbstentionReasonCategory =
  | "pre_analysis_gate"
  | "capture_envelope"
  | "no_target_lock"
  | "no_event_proposed"
  | "stroke_confidence"
  | "phase_evidence"
  | "contact_evidence"
  | "model_unavailable"
  | "other";

export const ABSTENTION_REASON_CATEGORIES: readonly AbstentionReasonCategory[] = [
  "pre_analysis_gate",
  "capture_envelope",
  "no_target_lock",
  "no_event_proposed",
  "stroke_confidence",
  "phase_evidence",
  "contact_evidence",
  "model_unavailable",
  "other",
];

export type AnalyticsEvent = Base &
  (
    | { name: "app_opened" }
    | { name: "onboarding_started" }
    | { name: "onboarding_completed"; skillLevel: string; handedness: string }
    | { name: "goal_selected"; goal: string }
    | { name: "shot_type_selected"; shotType: ShotTypeSlug }
    | { name: "camera_preflight_started" }
    | { name: "camera_preflight_passed"; attempts: number }
    | { name: "capture_started"; mode: "single" | "live" | "import" }
    | { name: "shot_detected"; shotType: ShotTypeSlug }
    | { name: "analysis_started"; inferenceMode: "on_device" | "cloud_deep"; modelVersion?: string }
    | {
        name: "analysis_completed";
        shotType: ShotTypeSlug;
        confidenceBand: "normal" | "lower";
        latencyMs?: number;
        modelVersion?: string;
      }
    | { name: "analysis_low_confidence"; shotType: ShotTypeSlug }
    | { name: "analysis_failed"; failureKind: string; latencyMs?: number; modelVersion?: string }
    | {
        name: "analysis_abstained";
        reasonCategory: AbstentionReasonCategory;
        latencyMs?: number;
        modelVersion?: string;
      }
    | {
        name: "capture_envelope_verdict";
        overall: "SUPPORTED" | "DEGRADED" | "UNSUPPORTED";
        /** Dimension names (e.g. "brightness") that were DEGRADED/UNSUPPORTED. */
        failedDimensions: string[];
        notMeasuredCount: number;
        thresholdsVersion: string;
      }
    | {
        name: "target_lock_failed";
        reason: "no_lock" | "ambiguity_timeout";
        ambiguityEntered: boolean;
        timeToFailMs?: number;
        algorithmVersion: string;
      }
    | { name: "event_proposal_failed"; reasonCategory: "no_event_proposed" | "event_rejected" }
    | {
        name: "app_crash";
        /** Stable hash of the symbolicated top frame — never a stack trace body. */
        fingerprint: string;
        fatal: boolean;
      }
    | { name: "worker_failure"; jobKind: string; failureKind: string }
    | { name: "queue_backlog"; queue: string; depth: number; oldestJobAgeMs?: number }
    | {
        /** Stalled-queue alert (typed, loud): visible work is not completing. */
        name: "queue_stalled";
        queue: string;
        reason: "no_progress" | "oldest_job_age_exceeded";
        depth: number;
        oldestJobAgeMs?: number;
        consecutiveIdleCycles: number;
      }
    | {
        /** Worker poll-loop crash survived by the supervisor loop. */
        name: "worker_crash";
        /** Crashes since this worker process started. */
        crashCount: number;
      }
    | {
        /** Worker process (re)start; restart counts come from counting these. */
        name: "worker_started";
      }
    | {
        name: "deletion_backlog";
        /** deletion_task rows not yet done. */
        pending: number;
        oldestAgeSeconds?: number;
        /** Rows failed past the retry cap — permanently stuck, needs a human. */
        exhausted: number;
      }
    | {
        name: "media_storage_failure";
        operation: "purge" | "sweep" | "transcode";
      }
    | {
        name: "api_failure";
        /** Route TEMPLATE (e.g. "/v1/shots/:id"), never a concrete URL. */
        route: string;
        method: string;
        statusCode: number;
        errorCode: string;
      }
    | { name: "score_viewed"; shotType: ShotTypeSlug }
    | { name: "checkpoint_opened"; checkpoint: CheckpointKey }
    | { name: "drill_opened"; drillSlug: string }
    | { name: "drill_started"; drillSlug: string }
    | { name: "drill_completed"; drillSlug: string }
    | { name: "live_court_started"; shotType: ShotTypeSlug; focus: CheckpointKey }
    | { name: "live_shot_scored"; repIndex: number }
    | { name: "voice_cue_played"; category: string }
    | { name: "live_session_completed"; validShots: number; durationSec: number }
    | { name: "weekly_review_viewed" }
    | { name: "share_created"; templateKey: string }
    | { name: "friend_request_sent" }
    | { name: "paywall_viewed"; placement: string }
    | { name: "trial_started"; productKey: string }
    | { name: "subscription_started"; productKey: string }
    | { name: "subscription_renewed"; productKey: string }
    | { name: "subscription_cancelled"; productKey: string }
    | { name: "cloud_sync_enabled"; enabled: boolean }
    | { name: "ml_training_consent_changed"; granted: boolean }
    | { name: "account_export_requested" }
    | { name: "account_delete_requested" }
  );

export type AnalyticsEventName = AnalyticsEvent["name"];

/**
 * Runtime list of every event name in the union above. `satisfies` keeps it
 * in exact sync: adding a union member without listing it here (or vice
 * versa) is a compile error. Operational queries/alert configs are validated
 * against this list in tests.
 */
export const ANALYTICS_EVENT_NAMES = [
  "app_opened",
  "onboarding_started",
  "onboarding_completed",
  "goal_selected",
  "shot_type_selected",
  "camera_preflight_started",
  "camera_preflight_passed",
  "capture_started",
  "shot_detected",
  "analysis_started",
  "analysis_completed",
  "analysis_low_confidence",
  "analysis_failed",
  "analysis_abstained",
  "capture_envelope_verdict",
  "target_lock_failed",
  "event_proposal_failed",
  "app_crash",
  "worker_failure",
  "queue_backlog",
  "queue_stalled",
  "worker_crash",
  "worker_started",
  "deletion_backlog",
  "media_storage_failure",
  "api_failure",
  "score_viewed",
  "checkpoint_opened",
  "drill_opened",
  "drill_started",
  "drill_completed",
  "live_court_started",
  "live_shot_scored",
  "voice_cue_played",
  "live_session_completed",
  "weekly_review_viewed",
  "share_created",
  "friend_request_sent",
  "paywall_viewed",
  "trial_started",
  "subscription_started",
  "subscription_renewed",
  "subscription_cancelled",
  "cloud_sync_enabled",
  "ml_training_consent_changed",
  "account_export_requested",
  "account_delete_requested",
] as const satisfies readonly AnalyticsEventName[];

type EventNameListIsExhaustive = AnalyticsEventName extends (typeof ANALYTICS_EVENT_NAMES)[number]
  ? true
  : never;
const eventNameListIsExhaustive: EventNameListIsExhaustive = true;
void eventNameListIsExhaustive;

/** One detected privacy violation inside an event about to be tracked. */
export interface PrivacyViolation {
  /** Dot path to the offending value inside the event. */
  path: string;
  rule:
    | "uri_scheme"
    | "filesystem_path"
    | "email_address"
    | "base64_blob"
    | "oversized_string"
    | "oversized_array"
    | "forbidden_key";
}

const URI_SCHEME = /\b(?:file|content|assets-library|ph|s3|blob|data):\/?\//i;
const FILESYSTEM_PATH = /(?:^|[\s="'(])\/(?:var|private|Users|data|storage|tmp|home)\//;
const EMAIL_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// A long unbroken base64-looking run — media/blob payloads, never a label.
const BASE64_BLOB = /[A-Za-z0-9+/]{120,}={0,2}/;
const FORBIDDEN_KEY =
  /^(?:uri|url|path|filePath|fileUri|objectKey|masterKey|email|phone|address|deviceId|idfa|aaid|serial|stack|stackTrace|rawFrame|imageData|videoData|poseFrames)$/i;
export const MAX_ANALYTICS_STRING_LENGTH = 200;
export const MAX_ANALYTICS_ARRAY_LENGTH = 32;

function scanValue(value: unknown, path: string, out: PrivacyViolation[]): void {
  if (typeof value === "string") {
    if (value.length > MAX_ANALYTICS_STRING_LENGTH) out.push({ path, rule: "oversized_string" });
    if (URI_SCHEME.test(value)) out.push({ path, rule: "uri_scheme" });
    if (FILESYSTEM_PATH.test(value)) out.push({ path, rule: "filesystem_path" });
    if (EMAIL_ADDRESS.test(value)) out.push({ path, rule: "email_address" });
    if (BASE64_BLOB.test(value)) out.push({ path, rule: "base64_blob" });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ANALYTICS_ARRAY_LENGTH) out.push({ path, rule: "oversized_array" });
    value.forEach((item, i) => scanValue(item, `${path}[${i}]`, out));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (FORBIDDEN_KEY.test(key)) out.push({ path: childPath, rule: "forbidden_key" });
      scanValue(child, childPath, out);
    }
  }
}

/**
 * Redaction guard (directive §37): scans an event for raw media references,
 * filesystem/object-store paths, contact details, blob payloads, oversized
 * free-form values, and forbidden field names. Pure and structural — safe to
 * run on every track() call.
 */
export function findPrivacyViolations(event: AnalyticsEvent): PrivacyViolation[] {
  const out: PrivacyViolation[] = [];
  scanValue(event, "", out);
  return out;
}

export interface IAnalyticsSink {
  track(event: AnalyticsEvent): void;
  flush(): Promise<void>;
}

/**
 * Buffers events; a transport drains it. Used by mobile + services.
 * Every event passes the redaction guard before buffering: a violating event
 * is NEVER sent — it is counted and reported through `onViolation` so the
 * drop is visible, not silent.
 */
export class BufferedAnalytics implements IAnalyticsSink {
  private buffer: AnalyticsEvent[] = [];
  private violationCount = 0;
  constructor(
    private transport: (batch: AnalyticsEvent[]) => Promise<void>,
    private maxBuffer = 50,
    private onViolation?: (eventName: AnalyticsEventName, violations: PrivacyViolation[]) => void,
  ) {}

  track(event: AnalyticsEvent): void {
    const violations = findPrivacyViolations(event);
    if (violations.length > 0) {
      this.violationCount++;
      this.onViolation?.(event.name, violations);
      return;
    }
    this.buffer.push(event);
    if (this.buffer.length >= this.maxBuffer) void this.flush();
  }

  /** Events refused by the redaction guard since construction. */
  droppedViolationCount(): number {
    return this.violationCount;
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.transport(batch);
    } catch {
      // Failed delivery re-buffers (bounded) — analytics must never crash the app,
      // but failures are not silently dropped either.
      this.buffer = [...batch.slice(-this.maxBuffer), ...this.buffer];
    }
  }

  pendingCount(): number {
    return this.buffer.length;
  }
}
