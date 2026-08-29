import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AnalysisPermitFinalizeRequest, AnalysisPermitReserveRequest } from "@pickle/api-contracts";
import type { AppContext } from "../../context.js";
import { many, one } from "../../lib/db.js";
import { sendFailure } from "../../lib/replies.js";
import {
  AccessServiceError,
  finalizeAnalysisPermit,
  readAccessState,
  reserveAnalysisPermit,
} from "./access.js";
import {
  fetchRevenueCatCustomer,
  loadRevenueCatConfig,
  persistRevenueCatCustomer,
  RevenueCatError,
  revenueCatPayloadHash,
  verifyWebhookAuthorization,
} from "./revenueCat.js";

const RevenueCatWebhook = z.object({
  api_version: z.string().optional(),
  event: z
    .object({
      id: z.string().min(1).max(300),
      app_user_id: z.string().min(1).max(1500),
      original_app_user_id: z.string().min(1).max(1500).optional(),
      aliases: z.array(z.string().min(1).max(1500)).max(100).optional(),
    })
    .loose(),
});

function sendAccessServiceError(
  reply: FastifyReply,
  request: FastifyRequest,
  error: AccessServiceError,
) {
  return sendFailure(
    reply,
    request,
    error.statusCode,
    error.statusCode === 402 ? "permission_denied" : "permanent",
    error.code,
    error.message,
  );
}

function sendRevenueCatError(reply: FastifyReply, request: FastifyRequest, error: RevenueCatError) {
  return sendFailure(
    reply,
    request,
    error.retryable ? 503 : 502,
    error.retryable ? "retryable" : "permanent",
    error.code,
    error.message,
  );
}

async function resolveRevenueCatUser(
  context: AppContext,
  candidates: string[],
): Promise<string | null> {
  const validIds = [
    ...new Set(candidates.filter((candidate) => z.uuid().safeParse(candidate).success)),
  ];
  if (validIds.length === 0) return null;
  const row = await one<{ id: string }>(
    context.pool!,
    `SELECT id FROM app_user
     WHERE status = 'active' AND id = ANY($1::uuid[])
     ORDER BY array_position($1::uuid[], id) LIMIT 1`,
    [validIds],
  );
  return row?.id ?? null;
}

/**
 * Billing and rating-access routes. The client may request a refresh, but it
 * never supplies subscription status: canonical state is read from
 * RevenueCat's authenticated server API and then stored with provider
 * provenance.
 */
export function registerBillingRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/v1/billing/offerings", { preHandler: app.authenticate }, async () => {
    const products = await many(
      context.pool!,
      `SELECT product_key, platform_product_ids, display_name, description, price_usd_cents,
              period, trial_days, features, display_order
       FROM billing_offering WHERE active ORDER BY display_order`,
      [],
    );
    return {
      products,
      // Trial eligibility is decided by StoreKit/Play through RevenueCat. The
      // server must not infer it from a missing entitlement.
      trialEligible: null,
      trialEligibilitySource: "store",
    };
  });

  app.get("/v1/me/access", { preHandler: app.authenticate }, async (request) =>
    readAccessState(context, request.user!.id),
  );

  app.post("/v1/analysis-permits", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = AnalysisPermitReserveRequest.safeParse(request.body);
    if (!parsed.success) {
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.analysis_permit",
        parsed.error.message,
      );
    }
    try {
      return await reserveAnalysisPermit(context, request.user!.id, parsed.data.idempotencyKey);
    } catch (error) {
      if (error instanceof AccessServiceError) {
        return sendAccessServiceError(reply, request, error);
      }
      throw error;
    }
  });

  app.post(
    "/v1/analysis-permits/:id/finalize",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const permitId = z.uuid().safeParse((request.params as { id?: string }).id);
      const body = AnalysisPermitFinalizeRequest.safeParse(request.body);
      if (!permitId.success || !body.success) {
        return sendFailure(
          reply,
          request,
          400,
          "permanent",
          "validation.analysis_permit_finalize",
          !permitId.success ? permitId.error.message : body.error!.message,
        );
      }
      try {
        return await finalizeAnalysisPermit(
          context,
          request.user!.id,
          permitId.data,
          body.data.outcome,
          body.data.ratingId,
        );
      } catch (error) {
        if (error instanceof AccessServiceError) {
          return sendAccessServiceError(reply, request, error);
        }
        throw error;
      }
    },
  );

  app.post("/v1/billing/sync", { preHandler: app.authenticate }, async (request, reply) => {
    const config = loadRevenueCatConfig();
    if (!config) {
      return sendFailure(
        reply,
        request,
        503,
        "retryable",
        "billing.revenuecat_unconfigured",
        "RevenueCat server verification requires REVENUECAT_SECRET_API_KEY.",
      );
    }
    try {
      const customer = await fetchRevenueCatCustomer(request.user!.id, config);
      const billing = await persistRevenueCatCustomer(context, request.user!.id, customer);
      return { billing, access: await readAccessState(context, request.user!.id) };
    } catch (error) {
      if (error instanceof RevenueCatError) return sendRevenueCatError(reply, request, error);
      throw error;
    }
  });

  app.post("/v1/webhooks/revenuecat", async (request, reply) => {
    const config = loadRevenueCatConfig();
    if (!config) {
      return sendFailure(
        reply,
        request,
        503,
        "retryable",
        "billing.revenuecat_unconfigured",
        "RevenueCat webhook processing requires REVENUECAT_SECRET_API_KEY.",
      );
    }
    if (!config.webhookAuthorization) {
      return sendFailure(
        reply,
        request,
        503,
        "retryable",
        "billing.revenuecat_webhook_unconfigured",
        "RevenueCat webhook authorization is not configured.",
      );
    }
    if (!verifyWebhookAuthorization(request.headers.authorization, config.webhookAuthorization)) {
      return sendFailure(
        reply,
        request,
        401,
        "auth_failed",
        "billing.revenuecat_webhook_unauthorized",
        "RevenueCat webhook authorization failed.",
      );
    }
    if (!context.pool) {
      return sendFailure(
        reply,
        request,
        503,
        "retryable",
        "billing.db_unavailable",
        "Database unavailable.",
      );
    }
    const parsed = RevenueCatWebhook.safeParse(request.body);
    if (!parsed.success) {
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.revenuecat_webhook",
        parsed.error.message,
      );
    }

    const event = parsed.data.event;
    const candidates = [
      event.app_user_id,
      event.original_app_user_id,
      ...(event.aliases ?? []),
    ].filter((value): value is string => Boolean(value));
    const userId = await resolveRevenueCatUser(context, candidates);
    await context.pool.query(
      `INSERT INTO billing_provider_event
         (provider, event_id, user_id, payload_sha256, status)
       VALUES ('revenuecat', $1, $2, $3, 'received')
       ON CONFLICT (provider, event_id) DO UPDATE SET
         user_id = COALESCE(billing_provider_event.user_id, EXCLUDED.user_id),
         received_at = now(), failure_code = NULL`,
      [event.id, userId, revenueCatPayloadHash(parsed.data)],
    );

    // A webhook for an anonymous/legacy RevenueCat ID cannot safely be mapped
    // to an app account. A later authenticated /billing/sync will reconcile it.
    if (!userId) {
      await context.pool.query(
        `UPDATE billing_provider_event SET status = 'processed', processed_at = now(),
           failure_code = 'billing.revenuecat_user_unmapped'
         WHERE provider = 'revenuecat' AND event_id = $1`,
        [event.id],
      );
      return { received: true, mapped: false };
    }

    try {
      // Never persist purchase facts from the webhook body. The authenticated
      // server API is re-read after every authorized notification.
      const customer = await fetchRevenueCatCustomer(userId, config);
      const billing = await persistRevenueCatCustomer(context, userId, customer);
      await context.pool.query(
        `UPDATE billing_provider_event SET status = 'processed', processed_at = now(), failure_code = NULL
         WHERE provider = 'revenuecat' AND event_id = $1`,
        [event.id],
      );
      return { received: true, mapped: true, billing };
    } catch (error) {
      const code = error instanceof RevenueCatError ? error.code : "billing.revenuecat_internal";
      await context.pool.query(
        `UPDATE billing_provider_event SET status = 'failed', failure_code = $2
         WHERE provider = 'revenuecat' AND event_id = $1`,
        [event.id, code],
      );
      if (error instanceof RevenueCatError) return sendRevenueCatError(reply, request, error);
      throw error;
    }
  });

  const storeNotConfigured = (platform: string) =>
    `${platform} direct receipt validation is not configured. Use the server-verified RevenueCat sync endpoint; validation is never faked.`;

  // Kept as explicit compatibility failures for older clients. They never
  // grant access and intentionally direct new clients to /v1/billing/sync.
  app.post("/v1/billing/apple/sync", { preHandler: app.authenticate }, async (request, reply) =>
    sendFailure(
      reply,
      request,
      501,
      "not_implemented",
      "billing.apple_unconfigured",
      storeNotConfigured("apple"),
    ),
  );
  app.post("/v1/billing/google/sync", { preHandler: app.authenticate }, async (request, reply) =>
    sendFailure(
      reply,
      request,
      501,
      "not_implemented",
      "billing.google_unconfigured",
      storeNotConfigured("google"),
    ),
  );
  app.post("/v1/webhooks/apple", async (request, reply) =>
    sendFailure(
      reply,
      request,
      503,
      "retryable",
      "billing.apple_unconfigured",
      "Direct Apple server notifications are not configured; RevenueCat is canonical.",
    ),
  );
  app.post("/v1/webhooks/google", async (request, reply) =>
    sendFailure(
      reply,
      request,
      503,
      "retryable",
      "billing.google_unconfigured",
      "Direct Play RTDN is not configured; RevenueCat is canonical.",
    ),
  );
}
