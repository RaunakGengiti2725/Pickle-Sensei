import { describe, expect, it } from "vitest";
import { MEDIA_RETENTION_POLICY_V1, isRetentionExpired, retentionDeadline } from "../src/index.js";

/**
 * Adjudication repro (stress area packages-ops-3, baseline 1fb0efd7).
 * Root cause: `retentionDeadline` builds `new Date(createdAt + days * MS_PER_DAY)`
 * without checking the ECMAScript time-value range (±8.64e15 ms), so a large
 * positive integer day count yields an Invalid Date (NaN time value) instead
 * of `null` ("never auto-expires"); `isRetentionExpired` then compares NaN.
 *
 * Replayed seed (packages/shared-types/test/stress, origin/devin/stress-pkg-shared-types-api-contracts-randomized-seeded):
 *   3546299114 — user_controlled, userRetentionDays = 1_000_000_000
 *
 * This test asserts the EXPECTED contract and therefore FAILS on 1fb0efd7.
 */

describe("shared-types mediaRetention: out-of-range deadlines are null, never Invalid Date", () => {
  it("seed 3546299114: user_controlled with 1e9 days", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const deadline = retentionDeadline({ kind: "user_controlled" }, createdAt, 1_000_000_000);
    if (deadline !== null) expect(Number.isNaN(deadline.getTime())).toBe(false);

    const expired = isRetentionExpired(
      { kind: "raw_video", createdAt, expiresAt: null, userRetentionDays: 1_000_000_000 },
      MEDIA_RETENTION_POLICY_V1,
      new Date("2026-06-01T00:00:00.000Z"),
    );
    expect(expired).toBe(false);
  });
});
