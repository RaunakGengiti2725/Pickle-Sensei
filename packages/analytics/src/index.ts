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
}

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
    | { name: "analysis_started"; inferenceMode: "on_device" | "cloud_deep" }
    | { name: "analysis_completed"; shotType: ShotTypeSlug; confidenceBand: "normal" | "lower" }
    | { name: "analysis_low_confidence"; shotType: ShotTypeSlug }
    | { name: "analysis_failed"; failureKind: string }
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

export interface IAnalyticsSink {
  track(event: AnalyticsEvent): void;
  flush(): Promise<void>;
}

/** Buffers events; a transport drains it. Used by mobile + services. */
export class BufferedAnalytics implements IAnalyticsSink {
  private buffer: AnalyticsEvent[] = [];
  constructor(
    private transport: (batch: AnalyticsEvent[]) => Promise<void>,
    private maxBuffer = 50,
  ) {}

  track(event: AnalyticsEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.maxBuffer) void this.flush();
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
