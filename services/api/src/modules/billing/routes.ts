import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { many } from "../../lib/db.js";

/**
 * Billing module. Offerings are remote-configurable rows (spec p. 55) — no
 * hard-coded pricing in clients. Store receipt validation requires Apple/Google
 * server credentials: without them these endpoints fail loudly with a typed
 * error — validation is NEVER faked (directive §5: no fake subscription
 * validation). Entitlement plumbing is real and tested via the admin path.
 */

export function registerBillingRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/v1/billing/offerings", { preHandler: app.authenticate }, async (request) => {
    const products = await many(
      context.pool!,
      `SELECT product_key, platform_product_ids, display_name, description, price_usd_cents,
              period, trial_days, features, display_order
       FROM billing_offering WHERE active ORDER BY display_order`,
      [],
    );
    const premium = await many(
      context.pool!,
      "SELECT feature_key FROM entitlement WHERE user_id = $1 AND (valid_to IS NULL OR valid_to > now())",
      [request.user!.id],
    );
    return { products, trialEligible: premium.length === 0 };
  });

  const storeNotConfigured = (platform: string) =>
    `${platform} receipt validation requires server credentials (${platform === "apple" ? "APPLE_IAP_KEY_ID/ISSUER/PRIVATE_KEY" : "GOOGLE_PLAY_SERVICE_ACCOUNT"}). Validation is never faked.`;

  app.post("/v1/billing/apple/sync", { preHandler: app.authenticate }, async (request, reply) => {
    if (!context.config.appleIapConfigured) {
      return sendFailure(
        reply,
        request,
        501,
        "not_implemented",
        "billing.apple_unconfigured",
        storeNotConfigured("apple"),
      );
    }
    // Real App Store Server API verification lands here once credentials exist.
    return sendFailure(
      reply,
      request,
      501,
      "not_implemented",
      "billing.apple_pending",
      "App Store server verification implementation pending credential setup.",
    );
  });

  app.post("/v1/billing/google/sync", { preHandler: app.authenticate }, async (request, reply) => {
    if (!context.config.googlePlayConfigured) {
      return sendFailure(
        reply,
        request,
        501,
        "not_implemented",
        "billing.google_unconfigured",
        storeNotConfigured("google"),
      );
    }
    return sendFailure(
      reply,
      request,
      501,
      "not_implemented",
      "billing.google_pending",
      "Play Developer API verification implementation pending credential setup.",
    );
  });

  app.post("/v1/webhooks/apple", async (request, reply) => {
    if (!context.config.appleIapConfigured) {
      return sendFailure(
        reply,
        request,
        503,
        "retryable",
        "billing.apple_unconfigured",
        "Apple server notifications not configured.",
      );
    }
    return sendFailure(
      reply,
      request,
      501,
      "not_implemented",
      "billing.apple_webhook_pending",
      "Pending credential setup.",
    );
  });

  app.post("/v1/webhooks/google", async (request, reply) => {
    if (!context.config.googlePlayConfigured) {
      return sendFailure(
        reply,
        request,
        503,
        "retryable",
        "billing.google_unconfigured",
        "Play RTDN not configured.",
      );
    }
    return sendFailure(
      reply,
      request,
      501,
      "not_implemented",
      "billing.google_webhook_pending",
      "Pending credential setup.",
    );
  });
}
