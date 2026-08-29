import { describe, expect, it } from "vitest";
import {
  MEDIA_ASSET_KINDS,
  MEDIA_RETENTION_POLICY_V1,
  isRetentionExpired,
  retentionDeadline,
  type MediaAssetKind,
} from "../src/index.js";

/**
 * Retention-policy invariants (Wave I i30). The policy must never default to
 * deleting user content (user_controlled without an opt-in window keeps
 * forever) and never auto-expire catalog/until_deleted kinds.
 */

const NOW = new Date("2026-08-29T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("media retention policy v1", () => {
  it("covers every media_asset kind with an explicit rule", () => {
    for (const kind of MEDIA_ASSET_KINDS) {
      expect(MEDIA_RETENTION_POLICY_V1.rules[kind]).toBeDefined();
    }
  });

  it("user content never auto-expires without an owner opt-in window", () => {
    for (const kind of ["raw_video", "normalized_video", "thumbnail", "features"] as const) {
      expect(
        isRetentionExpired(
          { kind, createdAt: daysAgo(10_000), expiresAt: null, userRetentionDays: null },
          MEDIA_RETENTION_POLICY_V1,
          NOW,
        ),
      ).toBe(false);
    }
  });

  it("honors the owner's opt-in retention window on user_controlled kinds", () => {
    const base = { kind: "raw_video" as MediaAssetKind, expiresAt: null, userRetentionDays: 7 };
    expect(
      isRetentionExpired({ ...base, createdAt: daysAgo(8) }, MEDIA_RETENTION_POLICY_V1, NOW),
    ).toBe(true);
    expect(
      isRetentionExpired({ ...base, createdAt: daysAgo(6) }, MEDIA_RETENTION_POLICY_V1, NOW),
    ).toBe(false);
  });

  it("ignores non-positive or non-integer opt-in windows (fail-open to retention, never deletion)", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(
        isRetentionExpired(
          {
            kind: "raw_video",
            createdAt: daysAgo(10_000),
            expiresAt: null,
            userRetentionDays: bad,
          },
          MEDIA_RETENTION_POLICY_V1,
          NOW,
        ),
      ).toBe(false);
    }
  });

  it("expires fixed_window kinds after the window", () => {
    expect(
      isRetentionExpired(
        { kind: "share_video", createdAt: daysAgo(31), expiresAt: null, userRetentionDays: null },
        MEDIA_RETENTION_POLICY_V1,
        NOW,
      ),
    ).toBe(true);
    expect(
      isRetentionExpired(
        { kind: "share_video", createdAt: daysAgo(29), expiresAt: null, userRetentionDays: null },
        MEDIA_RETENTION_POLICY_V1,
        NOW,
      ),
    ).toBe(false);
  });

  it("never auto-expires until_deleted kinds, regardless of age or owner window", () => {
    for (const kind of ["model_bundle", "drill_video", "reference_video"] as const) {
      expect(
        isRetentionExpired(
          { kind, createdAt: daysAgo(10_000), expiresAt: null, userRetentionDays: 1 },
          MEDIA_RETENTION_POLICY_V1,
          NOW,
        ),
      ).toBe(false);
      expect(retentionDeadline(MEDIA_RETENTION_POLICY_V1.rules[kind], daysAgo(10_000), 1)).toBe(
        null,
      );
    }
  });

  it("an explicit per-asset expires_at always wins over the kind rule", () => {
    // until_deleted kind with an explicit past expiry → expired.
    expect(
      isRetentionExpired(
        {
          kind: "drill_video",
          createdAt: daysAgo(1),
          expiresAt: daysAgo(0.5),
          userRetentionDays: null,
        },
        MEDIA_RETENTION_POLICY_V1,
        NOW,
      ),
    ).toBe(true);
    // fixed_window kind past its window but with an explicit future expiry → kept.
    expect(
      isRetentionExpired(
        {
          kind: "share_video",
          createdAt: daysAgo(100),
          expiresAt: new Date(NOW.getTime() + 1000),
          userRetentionDays: null,
        },
        MEDIA_RETENTION_POLICY_V1,
        NOW,
      ),
    ).toBe(false);
  });
});
