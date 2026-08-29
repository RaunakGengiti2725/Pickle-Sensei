import { describe, expect, it } from "vitest";
import {
  describeFailureCategory,
  failureCategoryTone,
  findForbiddenKeys,
  formatLatencyMs,
} from "../format";
import type { SupportAnalysisDiagnostics } from "../types";

describe("formatLatencyMs", () => {
  it("renders ms, seconds, and unknown legs", () => {
    expect(formatLatencyMs(230)).toBe("230ms");
    expect(formatLatencyMs(1500)).toBe("1.5s");
    expect(formatLatencyMs(0)).toBe("0ms");
    expect(formatLatencyMs(null)).toBe("—");
  });
});

describe("failure category presentation", () => {
  it("labels every category", () => {
    expect(describeFailureCategory("none")).toBe("completed");
    expect(describeFailureCategory("media")).toBe("media problem");
    expect(describeFailureCategory("cloud_model_unavailable")).toBe("cloud model unavailable");
    expect(describeFailureCategory("unclassified")).toBe("unclassified");
  });

  it("maps categories to tones", () => {
    expect(failureCategoryTone("none")).toBe("ok");
    expect(failureCategoryTone("in_queue")).toBe("pending");
    expect(failureCategoryTone("in_progress")).toBe("pending");
    expect(failureCategoryTone("media")).toBe("bad");
    expect(failureCategoryTone("unclassified")).toBe("bad");
  });
});

describe("client-side privacy gate", () => {
  const cleanReport: SupportAnalysisDiagnostics = {
    analysisId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    serverJobState: "failed",
    inferenceMode: "on_device",
    failureCode: "media.not_found",
    failureCategory: "media",
    requestedAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    latency: { queueMs: null, processingMs: null, totalMs: null },
    hasMedia: true,
    mediaStatus: "failed",
    hasSession: false,
    permit: { status: "released", outcome: "failed" },
    shotResultKind: null,
    pipelineVersions: { appVersion: "0.1.0" },
    device: null,
  };

  it("passes a clean allowlisted report", () => {
    expect(findForbiddenKeys({ diagnostics: cleanReport })).toEqual([]);
  });

  it("flags storage coordinates, tokens, and identity anywhere in the payload", () => {
    expect(
      findForbiddenKeys({
        diagnostics: { ...cleanReport, media: { objectKey: "s3://raw/video.mp4" } },
      }),
    ).toEqual(["$.diagnostics.media.objectKey"]);
    expect(findForbiddenKeys({ user: { email: "a@b.c" } })).toEqual(["$.user.email"]);
    expect(findForbiddenKeys([{ push_token: "tok" }])).toEqual(["$[0].push_token"]);
  });
});
