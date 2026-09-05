/**
 * Pins the redaction guard's coverage of the URI schemes its own rule names.
 *
 * `URI_SCHEME` (src/index.ts) lists `blob` and `data`, but requires a `/`
 * immediately after the colon. Real `blob:` URLs are `blob:<origin>/<uuid>`
 * and real `data:` URIs are `data:<mime>[;base64],<payload>` — neither has
 * that slash, so both pass the guard while short enough to dodge the
 * base64 / oversized rules. These cases FAIL on the current implementation;
 * they document the gap found by the stress campaign and become the
 * regression pin once the rule is fixed.
 */
import { describe, expect, it } from "vitest";
import { findPrivacyViolations, type AnalyticsEvent } from "../../src/index.js";

const at = "2026-09-05T00:00:00.000Z";

function withText(text: string): AnalyticsEvent {
  return { name: "analysis_failed", at, failureKind: text };
}

describe("redaction guard: URI schemes the rule claims to cover", () => {
  it.each([
    "file:///var/mobile/Containers/Data/clip.mov",
    "content://media/external/video/media/1234",
    "ph://8B1A2C3D-4E5F-6071-8293-A4B5C6D7E8F9/L0/001",
    "assets-library://asset/asset.MOV?id=8B1A2C3D&ext=MOV",
    "s3://pickle-media/master/abc.mp4",
  ])("flags %s (slash-form)", (uri) => {
    expect(findPrivacyViolations(withText(uri)).map((v) => v.rule)).toContain("uri_scheme");
  });

  it.each([
    "blob:https://app.example.invalid/8a1e2c3d-4f5a-6b7c-8d9e-0f1a2b3c4d5e",
    "blob:null/8a1e2c3d-4f5a-6b7c-8d9e-0f1a2b3c4d5e",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk",
    "data:text/plain,hello",
  ])("flags %s (real-world form of a listed scheme)", (uri) => {
    const rules = findPrivacyViolations(withText(uri)).map((v) => v.rule);
    expect(rules, `guard let a listed scheme through: ${uri}`).toContain("uri_scheme");
  });
});
