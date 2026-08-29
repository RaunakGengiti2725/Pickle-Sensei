import type { AppContext } from "../../context.js";
import { one } from "../../lib/db.js";

/**
 * Canonical backend entitlements (directive §35): premium checks never live in
 * UI state. Store platforms grant subscriptions; subscriptions grant the
 * `premium` entitlement; features check entitlements.
 */

export async function hasEntitlement(
  context: AppContext,
  userId: string,
  featureKey: string,
): Promise<boolean> {
  const row = await one(
    context.pool!,
    "SELECT 1 AS ok FROM entitlement WHERE user_id = $1 AND feature_key = $2 AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())",
    [userId, featureKey],
  );
  return row !== null;
}

export async function grantEntitlement(
  context: AppContext,
  userId: string,
  featureKey: string,
  subscriptionId: string | null,
  validTo: Date | null,
): Promise<void> {
  await context.pool!.query(
    `INSERT INTO entitlement (user_id, feature_key, subscription_id, valid_from, valid_to, source)
     VALUES ($1, $2, $3, now(), $4, 'admin')
     ON CONFLICT (user_id, feature_key) DO UPDATE SET
       subscription_id = EXCLUDED.subscription_id,
       valid_from = EXCLUDED.valid_from,
       valid_to = EXCLUDED.valid_to,
       source = 'admin'`,
    [userId, featureKey, subscriptionId, validTo],
  );
}
