/**
 * Media retention policy (directive §58, spec pp. 38–41).
 *
 * Every media_asset kind carries an explicit retention rule; enforcement is a
 * worker sweep that marks expired assets deleted and purges their objects.
 * The policy is deliberately conservative:
 *  - user-captured video is retained until the user deletes it, unless the
 *    user opted into an automatic retention window (user_setting
 *    .local_video_retention_days) — retention never defaults to deletion of
 *    user content, and never to indefinite retention of derived artifacts.
 *  - an explicit per-asset expires_at always wins over the kind rule.
 */

export const MEDIA_ASSET_KINDS = [
  "raw_video",
  "normalized_video",
  "thumbnail",
  "share_video",
  "features",
  "model_bundle",
  "drill_video",
  "reference_video",
] as const;
export type MediaAssetKind = (typeof MEDIA_ASSET_KINDS)[number];

export type MediaRetentionRule =
  /** Kept until the owner deletes it; the owner's opt-in retention window
   *  (user_setting.local_video_retention_days) is honored when set. */
  | { readonly kind: "user_controlled" }
  /** Deleted automatically once the asset is older than `days`. */
  | { readonly kind: "fixed_window"; readonly days: number }
  /** Kept until explicitly deleted; never auto-expired by the sweep. */
  | { readonly kind: "until_deleted" };

export interface MediaRetentionPolicy {
  readonly version: string;
  readonly rules: Readonly<Record<MediaAssetKind, MediaRetentionRule>>;
}

/**
 * v1 policy. Share renders are short-lived derived artifacts (the source
 * video remains); everything user-captured or catalog-owned is retained
 * until deleted through its own workflow.
 */
export const MEDIA_RETENTION_POLICY_V1: MediaRetentionPolicy = {
  version: "media-retention-v1",
  rules: {
    raw_video: { kind: "user_controlled" },
    normalized_video: { kind: "user_controlled" },
    thumbnail: { kind: "user_controlled" },
    share_video: { kind: "fixed_window", days: 30 },
    features: { kind: "user_controlled" },
    model_bundle: { kind: "until_deleted" },
    drill_video: { kind: "until_deleted" },
    reference_video: { kind: "until_deleted" },
  },
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The moment an asset expires under a rule, or null when it never
 * auto-expires. `userRetentionDays` is the owner's opt-in window
 * (user_setting.local_video_retention_days); it only applies to
 * user_controlled kinds and only when the owner set it.
 */
export function retentionDeadline(
  rule: MediaRetentionRule,
  createdAt: Date,
  userRetentionDays: number | null,
): Date | null {
  switch (rule.kind) {
    case "until_deleted":
      return null;
    case "fixed_window":
      return new Date(createdAt.getTime() + rule.days * MS_PER_DAY);
    case "user_controlled":
      if (userRetentionDays === null || !Number.isInteger(userRetentionDays)) return null;
      if (userRetentionDays <= 0) return null;
      return new Date(createdAt.getTime() + userRetentionDays * MS_PER_DAY);
  }
}

/**
 * Whether an asset is expired at `now`. An explicit per-asset expires_at
 * always takes precedence over the kind rule.
 */
export function isRetentionExpired(
  input: {
    readonly kind: MediaAssetKind;
    readonly createdAt: Date;
    readonly expiresAt: Date | null;
    readonly userRetentionDays: number | null;
  },
  policy: MediaRetentionPolicy,
  now: Date,
): boolean {
  if (input.expiresAt !== null) return input.expiresAt.getTime() <= now.getTime();
  const deadline = retentionDeadline(
    policy.rules[input.kind],
    input.createdAt,
    input.userRetentionDays,
  );
  return deadline !== null && deadline.getTime() <= now.getTime();
}
