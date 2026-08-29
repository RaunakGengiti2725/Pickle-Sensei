import { describe, expect, it } from "vitest";
import {
  buildSupportDiagnostics,
  categorizeAnalysisFailure,
  computeLatency,
  findForbiddenKeys,
  projectPipelineVersions,
  type AnalysisJobDiagnosticsRow,
} from "../src/modules/admin/supportDiagnostics.js";

describe("categorizeAnalysisFailure", () => {
  it("maps non-failed server job states to their own categories", () => {
    expect(categorizeAnalysisFailure("complete", null)).toBe("none");
    expect(categorizeAnalysisFailure("queued", null)).toBe("in_queue");
    expect(categorizeAnalysisFailure("processing", null)).toBe("in_progress");
    expect(categorizeAnalysisFailure("cancelled", null)).toBe("cancelled");
  });

  it("maps machine failure codes by namespace", () => {
    expect(categorizeAnalysisFailure("failed", "analysis.cloud_model_unavailable")).toBe(
      "cloud_model_unavailable",
    );
    expect(categorizeAnalysisFailure("failed", "media.not_found")).toBe("media");
    expect(categorizeAnalysisFailure("failed", "validation.analysis")).toBe("validation");
    expect(categorizeAnalysisFailure("failed", "access.permit_exhausted")).toBe("quota");
    expect(categorizeAnalysisFailure("failed", "billing.quota_exceeded")).toBe("quota");
    expect(categorizeAnalysisFailure("failed", "analysis.worker_crash")).toBe("pipeline");
  });

  it("reports honest uncertainty for unknown or missing codes", () => {
    expect(categorizeAnalysisFailure("failed", null)).toBe("unclassified");
    expect(categorizeAnalysisFailure("failed", "something.novel")).toBe("unclassified");
    expect(categorizeAnalysisFailure("bogus_state", "media.x")).toBe("unclassified");
  });
});

describe("computeLatency", () => {
  const t0 = new Date("2026-01-01T00:00:00.000Z");
  const t1 = new Date("2026-01-01T00:00:01.500Z");
  const t2 = new Date("2026-01-01T00:00:04.000Z");

  it("computes each leg from server timestamps", () => {
    expect(computeLatency(t0, t1, t2)).toEqual({
      queueMs: 1500,
      processingMs: 2500,
      totalMs: 4000,
    });
  });

  it("returns null for legs that have not happened", () => {
    expect(computeLatency(t0, null, null)).toEqual({
      queueMs: null,
      processingMs: null,
      totalMs: null,
    });
    expect(computeLatency(t0, null, t2)).toEqual({
      queueMs: null,
      processingMs: null,
      totalMs: 4000,
    });
  });
});

describe("projectPipelineVersions", () => {
  it("keeps only allowlisted string version keys", () => {
    const projected = projectPipelineVersions({
      appVersion: "0.1.0",
      modelBundleVersion: "bundle-1",
      scoringModelVersion: "sm-v1",
      email: "leak@example.com",
      objectKey: "s3://raw/video.mp4",
      poseModelVersion: 42,
    });
    expect(projected).toEqual({
      appVersion: "0.1.0",
      modelBundleVersion: "bundle-1",
      scoringModelVersion: "sm-v1",
    });
  });

  it("returns empty for non-object vectors", () => {
    expect(projectPipelineVersions(null)).toEqual({});
    expect(projectPipelineVersions("v1")).toEqual({});
  });
});

describe("buildSupportDiagnostics redaction contract", () => {
  const job: AnalysisJobDiagnosticsRow = {
    id: "11111111-1111-4111-8111-111111111111",
    user_id: "22222222-2222-4222-8222-222222222222",
    status: "failed",
    inference_mode: "on_device",
    failure_code: "media.not_found",
    requested_at: new Date("2026-01-01T00:00:00.000Z"),
    started_at: new Date("2026-01-01T00:00:01.000Z"),
    finished_at: new Date("2026-01-01T00:00:02.000Z"),
    has_media: true,
    media_status: "failed",
    has_session: false,
    permit_status: "released",
    permit_outcome: "failed",
    shot_result_kind: null,
    shot_version_vector: { appVersion: "0.1.0", objectKey: "s3://raw/leak.mp4" },
  };

  it("assembles the allowlisted report", () => {
    const report = buildSupportDiagnostics(job, {
      platform: "ios",
      app_version: "0.1.0",
      os_version: "18.0",
      model: "iPhone16,1",
      device_tier: "A",
      model_bundle_version: "bundle-1",
    });
    expect(report.failureCategory).toBe("media");
    expect(report.serverJobState).toBe("failed");
    expect(report.latency.totalMs).toBe(2000);
    expect(report.permit).toEqual({ status: "released", outcome: "failed" });
    expect(report.device?.appVersion).toBe("0.1.0");
    expect(report.pipelineVersions).toEqual({ appVersion: "0.1.0" });
    expect(findForbiddenKeys(report)).toEqual([]);
  });

  it("handles a device-less user without fabricating device state", () => {
    const report = buildSupportDiagnostics(job, null);
    expect(report.device).toBeNull();
    expect(findForbiddenKeys(report)).toEqual([]);
  });

  it("findForbiddenKeys detects nested leaks", () => {
    expect(findForbiddenKeys({ nested: [{ objectKey: "s3://x" }] })).toEqual([
      "$.nested[0].objectKey",
    ]);
    expect(findForbiddenKeys({ user: { email: "x@example.com" } })).toEqual(["$.user.email"]);
  });
});
