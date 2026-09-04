import { describe, it } from "vitest";
import {
  MEDIA_ASSET_KINDS,
  MEDIA_RETENTION_POLICY_V1,
  isRetentionExpired,
  retentionDeadline,
  type MediaAssetKind,
  type MediaRetentionPolicy,
  type MediaRetentionRule,
} from "../../src/index.js";
import {
  bump,
  check,
  checkEqual,
  expectCampaignHeld,
  runStressCampaign,
  stable,
  type Rng,
  type StressCampaign,
  stressTestTimeoutMs,
} from "./harness.js";

/**
 * Seeded stress of the media retention policy (mediaRetention.ts):
 *  - an explicit expiresAt always wins over the policy-derived deadline;
 *  - until_deleted assets never expire automatically;
 *  - fixed_window deadlines are createdAt + days exactly;
 *  - user_controlled deadlines exist only for a positive INTEGER day count
 *    (null / 0 / negative / fractional / NaN / Infinity → never auto-expire);
 *  - expiry is a closed boundary (deadline <= now) and monotone in `now`;
 *  - pure: same inputs → same answer, no NaN dates for the legal domain.
 *
 * Each sequence draws a random policy (all three rule kinds across the
 * asset kinds) so the frozen v1 policy is one point of a larger space.
 */

const MS_PER_DAY = 86_400_000;
const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");

type Action = {
  kind: "probe";
  asset: MediaAssetKind;
  createdOffsetDays: number;
  expiresOffsetDays: number | null;
  userDays: number | null;
  nowOffsetMs: number;
};

interface Model {
  policy: MediaRetentionPolicy;
}

const IRREGULAR_USER_DAYS = [
  0,
  -1,
  -365,
  0.5,
  2.5,
  7.000001,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  1e-9,
];

function genAction(rng: Rng): Action {
  const createdOffsetDays = rng.int(0, 400);
  const userDays = rng.chance(0.2)
    ? null
    : rng.chance(0.25)
      ? rng.pick(IRREGULAR_USER_DAYS)
      : rng.int(1, 3650);
  // `now` is chosen to land exactly on, one ms before, or one ms after the
  // most likely deadline, plus a spread of unrelated instants.
  const anchorDays =
    createdOffsetDays +
    (typeof userDays === "number" && Number.isInteger(userDays) && userDays > 0 ? userDays : 30);
  const nowOffsetMs = rng.chance(0.5)
    ? anchorDays * MS_PER_DAY + rng.pick([-1, 0, 1])
    : rng.int(0, 5000 * MS_PER_DAY);
  return {
    kind: "probe",
    asset: rng.pick(MEDIA_ASSET_KINDS),
    createdOffsetDays,
    expiresOffsetDays: rng.chance(0.3) ? rng.int(0, 800) : null,
    userDays,
    nowOffsetMs,
  };
}

function randomPolicy(rng: Rng): MediaRetentionPolicy {
  if (rng.chance(0.3)) return MEDIA_RETENTION_POLICY_V1;
  const rules = {} as Record<MediaAssetKind, MediaRetentionRule>;
  for (const asset of MEDIA_ASSET_KINDS) {
    const roll = rng.next();
    rules[asset] =
      roll < 0.34
        ? { kind: "until_deleted" }
        : roll < 0.67
          ? { kind: "fixed_window", days: rng.int(1, 365) }
          : { kind: "user_controlled" };
  }
  return { version: "media-retention-v1", rules };
}

function expectedDeadlineMs(
  rule: MediaRetentionRule,
  createdMs: number,
  userDays: number | null,
): number | null {
  if (rule.kind === "until_deleted") return null;
  if (rule.kind === "fixed_window") return createdMs + rule.days * MS_PER_DAY;
  if (userDays === null || !Number.isInteger(userDays) || userDays <= 0) return null;
  return createdMs + userDays * MS_PER_DAY;
}

function makeCampaign(): StressCampaign<Action, Model> {
  const stats: Record<string, number> = {};
  return {
    name: "media-retention",
    stats,
    init: (rng) => ({ policy: randomPolicy(rng) }),
    genAction: (rng) => genAction(rng),
    step(model, action) {
      const rule = model.policy.rules[action.asset];
      const createdAt = new Date(BASE_MS + action.createdOffsetDays * MS_PER_DAY);
      const expiresAt =
        action.expiresOffsetDays === null
          ? null
          : new Date(BASE_MS + action.expiresOffsetDays * MS_PER_DAY);
      const now = new Date(BASE_MS + action.nowOffsetMs);
      const input = {
        kind: action.asset,
        createdAt,
        expiresAt,
        userRetentionDays: action.userDays,
      };

      const deadline = retentionDeadline(rule, createdAt, action.userDays);
      const wantDeadline = expectedDeadlineMs(rule, createdAt.getTime(), action.userDays);
      if (wantDeadline === null) {
        check(deadline === null, "no-deadline-for-until-deleted-or-invalid-user-days", () =>
          stable({ rule, action, deadline }),
        );
      } else {
        check(
          deadline !== null && deadline.getTime() === wantDeadline,
          "deadline-is-created-plus-days",
          () => stable({ rule, action, deadline, wantDeadline }),
        );
        check(Number.isFinite(deadline!.getTime()), "deadline-is-a-valid-date", () =>
          String(deadline),
        );
      }
      checkEqual(
        retentionDeadline(rule, createdAt, action.userDays)?.getTime() ?? null,
        deadline?.getTime() ?? null,
        "deadline-deterministic",
      );

      const expired = isRetentionExpired(input, model.policy, now);
      check(typeof expired === "boolean", "expiry-is-boolean", () => String(expired));
      const wantExpired =
        expiresAt !== null
          ? expiresAt.getTime() <= now.getTime()
          : wantDeadline !== null && wantDeadline <= now.getTime();
      checkEqual(
        expired,
        wantExpired,
        "explicit-expiresAt-wins-then-policy-deadline-closed-boundary",
      );
      if (expiresAt === null && rule.kind === "until_deleted")
        check(!expired, "until-deleted-never-auto-expires", () => stable(action));
      if (
        expiresAt === null &&
        rule.kind === "user_controlled" &&
        (action.userDays === null || !Number.isInteger(action.userDays) || action.userDays <= 0)
      ) {
        check(!expired, "irregular-user-days-never-auto-expire", () => stable(action));
      }
      // Monotone in now: once expired, stays expired.
      check(
        !expired || isRetentionExpired(input, model.policy, new Date(now.getTime() + 1)),
        "expiry-monotone-in-now",
        () => stable(action),
      );
      check(
        expired || !isRetentionExpired(input, model.policy, new Date(now.getTime() - 1)),
        "non-expiry-monotone-in-now",
        () => stable(action),
      );
      checkEqual(isRetentionExpired(input, model.policy, now), expired, "expiry-deterministic");

      bump(stats, `${rule.kind}_${expired ? "expired" : "retained"}`);
      if (expiresAt !== null) bump(stats, "explicit_expiresAt");
      return `${action.asset}:${rule.kind}:${expired ? 1 : 0}:${deadline?.getTime() ?? "null"}`;
    },
  };
}

describe("media retention — seeded randomized long-run", () => {
  it(
    "derives deadlines and expiry exactly per policy with explicit expiresAt precedence",
    async () => {
      expectCampaignHeld(await runStressCampaign(makeCampaign()));
    },
    stressTestTimeoutMs(),
  );
});
