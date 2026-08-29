import { describe, expect, it } from "vitest";
import {
  ABSTENTION_REASON_CATEGORIES,
  ANALYTICS_EVENT_NAMES,
  BufferedAnalytics,
  findPrivacyViolations,
  MAX_ANALYTICS_ARRAY_LENGTH,
  MAX_ANALYTICS_STRING_LENGTH,
  type AnalyticsEvent,
  type PrivacyViolation,
} from "../src/index.js";

const at = "2026-08-29T12:00:00.000Z";

describe("findPrivacyViolations", () => {
  it("passes every well-formed operational event untouched", () => {
    const events: AnalyticsEvent[] = [
      {
        name: "analysis_started",
        at,
        inferenceMode: "on_device",
        modelVersion: "stroke-heuristic-2",
      },
      {
        name: "analysis_completed",
        at,
        shotType: "forehand_drive",
        confidenceBand: "normal",
        latencyMs: 17250,
        modelVersion: "stroke-heuristic-2",
      },
      { name: "analysis_failed", at, failureKind: "pose_extraction_error", latencyMs: 900 },
      { name: "analysis_abstained", at, reasonCategory: "stroke_confidence", latencyMs: 12000 },
      {
        name: "capture_envelope_verdict",
        at,
        overall: "DEGRADED",
        failedDimensions: ["brightness", "motion_blur"],
        notMeasuredCount: 2,
        thresholdsVersion: "capture-envelope-thresholds-v0.1-provisional",
      },
      {
        name: "target_lock_failed",
        at,
        reason: "ambiguity_timeout",
        ambiguityEntered: true,
        timeToFailMs: 3000,
        algorithmVersion: "D-027",
      },
      { name: "event_proposal_failed", at, reasonCategory: "no_event_proposed" },
      { name: "app_crash", at, fingerprint: "a1b2c3d4e5f6", fatal: true },
      { name: "worker_failure", at, jobKind: "media.process", failureKind: "transcode_failed" },
      { name: "queue_backlog", at, queue: "media", depth: 42 },
      {
        name: "api_failure",
        at,
        route: "/v1/shots/:id",
        method: "POST",
        statusCode: 500,
        errorCode: "internal",
      },
    ];
    for (const event of events) {
      expect(findPrivacyViolations(event)).toEqual([]);
    }
  });

  it("flags raw media URIs (file/content/ph schemes)", () => {
    const event: AnalyticsEvent = {
      name: "analysis_failed",
      at,
      failureKind: "read error at file:///var/mobile/Containers/clip.mov",
    };
    const rules = findPrivacyViolations(event).map((v: PrivacyViolation) => v.rule);
    expect(rules).toContain("uri_scheme");
  });

  it("flags filesystem paths", () => {
    const event: AnalyticsEvent = {
      name: "worker_failure",
      at,
      jobKind: "media.process",
      failureKind: "ENOENT /var/data/media/user-123/master.mp4",
    };
    const rules = findPrivacyViolations(event).map((v) => v.rule);
    expect(rules).toContain("filesystem_path");
  });

  it("flags email addresses", () => {
    const event: AnalyticsEvent = {
      name: "analysis_failed",
      at,
      failureKind: "upload rejected for player@example.com",
    };
    const rules = findPrivacyViolations(event).map((v) => v.rule);
    expect(rules).toContain("email_address");
  });

  it("flags base64 blob payloads", () => {
    const event: AnalyticsEvent = {
      name: "analysis_failed",
      at,
      failureKind: "A".repeat(150),
    };
    const rules = findPrivacyViolations(event).map((v) => v.rule);
    expect(rules).toContain("base64_blob");
  });

  it("flags oversized strings and arrays (raw-signal smuggling)", () => {
    const longString: AnalyticsEvent = {
      name: "analysis_failed",
      at,
      failureKind: "x y ".repeat(MAX_ANALYTICS_STRING_LENGTH),
    };
    expect(findPrivacyViolations(longString).map((v) => v.rule)).toContain("oversized_string");

    const longArray: AnalyticsEvent = {
      name: "capture_envelope_verdict",
      at,
      overall: "UNSUPPORTED",
      failedDimensions: Array.from({ length: MAX_ANALYTICS_ARRAY_LENGTH + 1 }, (_, i) => `d${i}`),
      notMeasuredCount: 0,
      thresholdsVersion: "v0.1",
    };
    expect(findPrivacyViolations(longArray).map((v) => v.rule)).toContain("oversized_array");
  });

  it("flags forbidden keys wherever they appear", () => {
    const event = {
      name: "analysis_failed",
      at,
      failureKind: "err",
      objectKey: "media/user-1/clip",
    } as unknown as AnalyticsEvent;
    const violations = findPrivacyViolations(event);
    expect(violations.map((v) => v.rule)).toContain("forbidden_key");
    expect(violations.map((v) => v.path)).toContain("objectKey");
  });
});

describe("BufferedAnalytics redaction enforcement", () => {
  it("refuses to buffer violating events and reports the drop", async () => {
    const sent: AnalyticsEvent[][] = [];
    const reported: string[] = [];
    const analytics = new BufferedAnalytics(
      async (batch) => {
        sent.push(batch);
      },
      50,
      (eventName) => reported.push(eventName),
    );
    analytics.track({
      name: "analysis_failed",
      at,
      failureKind: "file:///private/var/clip.mov unreadable",
    });
    analytics.track({ name: "analysis_failed", at, failureKind: "pose_extraction_error" });
    await analytics.flush();
    expect(analytics.droppedViolationCount()).toBe(1);
    expect(reported).toEqual(["analysis_failed"]);
    expect(sent.flat()).toHaveLength(1);
    expect(sent.flat()[0]).toMatchObject({ failureKind: "pose_extraction_error" });
  });
});

describe("taxonomy runtime list", () => {
  it("contains every Gate-15 operational signal", () => {
    for (const required of [
      "analysis_started",
      "analysis_completed",
      "analysis_failed",
      "analysis_abstained",
      "capture_envelope_verdict",
      "target_lock_failed",
      "event_proposal_failed",
      "app_crash",
      "worker_failure",
      "queue_backlog",
      "api_failure",
    ]) {
      expect(ANALYTICS_EVENT_NAMES).toContain(required);
    }
  });

  it("has no duplicate event names or abstention categories", () => {
    expect(new Set(ANALYTICS_EVENT_NAMES).size).toBe(ANALYTICS_EVENT_NAMES.length);
    expect(new Set(ABSTENTION_REASON_CATEGORIES).size).toBe(ABSTENTION_REASON_CATEGORIES.length);
  });
});
