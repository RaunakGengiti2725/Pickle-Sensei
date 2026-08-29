import { createHash, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { many, one, withTransaction } from "../../lib/db.js";

const RevenueCatSubscription = z
  .object({
    billing_issues_detected_at: z.string().nullable().optional(),
    expires_date: z.string().nullable(),
    grace_period_expires_date: z.string().nullable().optional(),
    is_sandbox: z.boolean().optional(),
    original_purchase_date: z.string().nullable().optional(),
    original_transaction_id: z.string().nullable().optional(),
    period_type: z.string().optional(),
    purchase_date: z.string().nullable().optional(),
    store: z.string(),
    unsubscribe_detected_at: z.string().nullable().optional(),
  })
  .loose();

const RevenueCatEntitlement = z
  .object({
    expires_date: z.string().nullable(),
    grace_period_expires_date: z.string().nullable().optional(),
    product_identifier: z.string(),
    purchase_date: z.string().nullable().optional(),
  })
  .loose();

const RevenueCatCustomerResponse = z.object({
  subscriber: z
    .object({
      entitlements: z.record(z.string(), RevenueCatEntitlement),
      subscriptions: z.record(z.string(), RevenueCatSubscription),
    })
    .loose(),
});

export type RevenueCatCustomer = z.infer<typeof RevenueCatCustomerResponse>;

export interface RevenueCatConfig {
  secretApiKey: string;
  webhookAuthorization: string | null;
}

export class RevenueCatError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export function loadRevenueCatConfig(
  env: NodeJS.ProcessEnv = process.env,
): RevenueCatConfig | null {
  const secretApiKey = env["REVENUECAT_SECRET_API_KEY"]?.trim();
  if (!secretApiKey) return null;
  return {
    secretApiKey,
    webhookAuthorization: env["REVENUECAT_WEBHOOK_AUTHORIZATION"]?.trim() || null,
  };
}

export function verifyWebhookAuthorization(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export async function fetchRevenueCatCustomer(
  appUserId: string,
  config: RevenueCatConfig,
): Promise<RevenueCatCustomer> {
  let response: Response;
  try {
    response = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${config.secretApiKey}`,
        },
        signal: AbortSignal.timeout(8_000),
      },
    );
  } catch (error) {
    throw new RevenueCatError(
      "billing.revenuecat_unavailable",
      `RevenueCat subscriber verification failed: ${String(error)}`,
      true,
    );
  }
  if (!response.ok) {
    throw new RevenueCatError(
      response.status === 401 || response.status === 403
        ? "billing.revenuecat_credentials_rejected"
        : "billing.revenuecat_unavailable",
      `RevenueCat subscriber verification returned HTTP ${response.status}.`,
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }
  const parsed = RevenueCatCustomerResponse.safeParse(await response.json());
  if (!parsed.success) {
    throw new RevenueCatError(
      "billing.revenuecat_invalid_response",
      "RevenueCat returned a subscriber payload that does not match the supported contract.",
      true,
    );
  }
  return parsed.data;
}

type Platform = "apple" | "google" | "web";

interface ProductConfig {
  productId: string;
  productKey: string;
  platform: Platform;
}

function platformForStore(store: string): Platform | null {
  switch (store.toUpperCase()) {
    case "APP_STORE":
    case "MAC_APP_STORE":
      return "apple";
    case "PLAY_STORE":
      return "google";
    case "STRIPE":
    case "RC_BILLING":
      return "web";
    default:
      return null;
  }
}

function dateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function laterDate(
  first: string | null | undefined,
  second: string | null | undefined,
): Date | null {
  const dates = [dateOrNull(first), dateOrNull(second)].filter((date): date is Date =>
    Boolean(date),
  );
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

async function configuredProducts(db: pg.PoolClient): Promise<Map<string, ProductConfig>> {
  const offerings = await many<{
    product_key: string;
    platform_product_ids: Record<string, unknown>;
  }>(
    db,
    `SELECT product_key, platform_product_ids FROM billing_offering
     WHERE active = true AND period IN ('monthly','annual')`,
    [],
  );
  const result = new Map<string, ProductConfig>();
  for (const offering of offerings) {
    for (const platform of ["apple", "google", "web"] as const) {
      const configured = offering.platform_product_ids[platform];
      const productIds = Array.isArray(configured) ? configured : [configured];
      for (const candidate of productIds) {
        if (typeof candidate === "string" && candidate.length > 0) {
          result.set(candidate, {
            productId: candidate,
            productKey: offering.product_key,
            platform,
          });
        }
      }
    }
  }
  return result;
}

export interface PersistedRevenueCatState {
  premium: boolean;
  productKey: string | null;
  expiresAt: string | null;
  verifiedAt: string;
}

/**
 * Persists only the server-fetched RevenueCat CustomerInfo. Client-submitted
 * product IDs, expiration dates, and entitlement booleans never reach here.
 */
export async function persistRevenueCatCustomer(
  context: AppContext,
  userId: string,
  customer: RevenueCatCustomer,
): Promise<PersistedRevenueCatState> {
  return withTransaction(context.pool!, async (tx) => {
    const user = await one<{ id: string }>(
      tx,
      "SELECT id FROM app_user WHERE id = $1 AND status = 'active' FOR UPDATE",
      [userId],
    );
    if (!user) {
      throw new RevenueCatError(
        "billing.revenuecat_user_unmapped",
        "RevenueCat customer is not linked to an active Pickle Sensei account.",
        false,
      );
    }

    const products = await configuredProducts(tx);
    const seenProductIds: string[] = [];
    const subscriptionIds = new Map<string, string>();
    const now = new Date();

    for (const [productId, subscription] of Object.entries(customer.subscriber.subscriptions)) {
      const configured = products.get(productId);
      const storePlatform = platformForStore(subscription.store);
      if (!configured || !storePlatform || configured.platform !== storePlatform) continue;
      seenProductIds.push(productId);
      const validTo = laterDate(subscription.expires_date, subscription.grace_period_expires_date);
      const active = Boolean(validTo && validTo.getTime() > now.getTime());
      const status = active
        ? subscription.billing_issues_detected_at
          ? "grace_period"
          : subscription.unsubscribe_detected_at
            ? "cancelled_active"
            : "active"
        : "expired";
      const existing = await one<{ id: string }>(
        tx,
        `SELECT id FROM billing_subscription
         WHERE user_id = $1 AND provider = 'revenuecat' AND product_id = $2
         ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
        [userId, productId],
      );
      const raw = JSON.stringify({ source: "revenuecat_customer_info", subscription });
      let subscriptionId = existing?.id;
      if (subscriptionId) {
        await tx.query(
          `UPDATE billing_subscription SET
             platform = $2, external_subscription_id = $3, status = $4,
             current_period_start = $5, current_period_end = $6,
             environment = $7, raw_last_event = $8,
             provider_customer_id = $1, provider_verified_at = now(), updated_at = now()
           WHERE id = $9`,
          [
            userId,
            storePlatform,
            subscription.original_transaction_id ?? null,
            status,
            dateOrNull(subscription.purchase_date ?? subscription.original_purchase_date),
            validTo,
            subscription.is_sandbox ? "sandbox" : "production",
            raw,
            subscriptionId,
          ],
        );
      } else {
        const inserted = await one<{ id: string }>(
          tx,
          `INSERT INTO billing_subscription
             (user_id, platform, product_id, external_subscription_id, status,
              current_period_start, current_period_end, environment, raw_last_event,
              provider, provider_customer_id, provider_verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'revenuecat',$10,now())
           RETURNING id`,
          [
            userId,
            storePlatform,
            productId,
            subscription.original_transaction_id ?? null,
            status,
            dateOrNull(subscription.purchase_date ?? subscription.original_purchase_date),
            validTo,
            subscription.is_sandbox ? "sandbox" : "production",
            raw,
            userId,
          ],
        );
        subscriptionId = inserted!.id;
      }
      subscriptionIds.set(productId, subscriptionId);
    }

    if (seenProductIds.length > 0) {
      await tx.query(
        `UPDATE billing_subscription
         SET status = 'expired', current_period_end = LEAST(COALESCE(current_period_end, now()), now()),
             provider_verified_at = now(), updated_at = now()
         WHERE user_id = $1 AND provider = 'revenuecat' AND NOT (product_id = ANY($2::text[]))`,
        [userId, seenProductIds],
      );
    } else {
      await tx.query(
        `UPDATE billing_subscription
         SET status = 'expired', current_period_end = LEAST(COALESCE(current_period_end, now()), now()),
             provider_verified_at = now(), updated_at = now()
         WHERE user_id = $1 AND provider = 'revenuecat'`,
        [userId],
      );
    }

    const premium = customer.subscriber.entitlements["premium"];
    const premiumProduct = premium ? products.get(premium.product_identifier) : undefined;
    const premiumExpiry = premium
      ? laterDate(premium.expires_date, premium.grace_period_expires_date)
      : null;
    const premiumActive = Boolean(
      premium &&
      premiumProduct &&
      subscriptionIds.has(premium.product_identifier) &&
      premiumExpiry &&
      premiumExpiry.getTime() > now.getTime(),
    );

    const existingEntitlement = await one<{ source: string; valid_to: Date | null }>(
      tx,
      `SELECT source, valid_to FROM entitlement
       WHERE user_id = $1 AND feature_key = 'premium' FOR UPDATE`,
      [userId],
    );
    const activeAdminGrant =
      existingEntitlement?.source === "admin" &&
      (!existingEntitlement.valid_to || existingEntitlement.valid_to.getTime() > now.getTime());

    if (premiumActive && !activeAdminGrant) {
      await tx.query(
        `INSERT INTO entitlement
           (user_id, feature_key, subscription_id, valid_from, valid_to, source)
         VALUES ($1, 'premium', $2, $3, $4, 'revenuecat')
         ON CONFLICT (user_id, feature_key) DO UPDATE SET
           subscription_id = EXCLUDED.subscription_id,
           valid_from = EXCLUDED.valid_from,
           valid_to = EXCLUDED.valid_to,
           source = 'revenuecat'`,
        [
          userId,
          subscriptionIds.get(premium!.product_identifier),
          dateOrNull(premium!.purchase_date) ?? now,
          premiumExpiry,
        ],
      );
    } else if (!premiumActive && existingEntitlement?.source === "revenuecat") {
      await tx.query(
        "DELETE FROM entitlement WHERE user_id = $1 AND feature_key = 'premium' AND source = 'revenuecat'",
        [userId],
      );
    }

    return {
      premium: premiumActive || activeAdminGrant,
      productKey: premiumActive ? premiumProduct!.productKey : null,
      expiresAt: premiumActive ? premiumExpiry!.toISOString() : null,
      verifiedAt: now.toISOString(),
    };
  });
}

export function revenueCatPayloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
