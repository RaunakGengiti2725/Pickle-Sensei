import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { buildOpenApiDocument } from "@pickle/api-contracts";
import { InMemoryJobQueue, SqsJobQueue, type IJobQueue } from "@pickle/queue";
import { BufferedAnalytics, type IAnalyticsSink } from "@pickle/analytics";
import type { ApiConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { failureCodeFor, sendFailure } from "./lib/replies.js";
import { buildVerifier } from "./auth/tokens.js";
import { registerAuth } from "./plugins/authPlugin.js";
import { buildObjectStore, type IObjectStore } from "./modules/media/objectStore.js";
import { registerCatalogRoutes } from "./modules/catalog/routes.js";
import { registerCatalogExtraRoutes } from "./modules/catalog/extraRoutes.js";
import { registerIdentityRoutes } from "./modules/identity/routes.js";
import { registerShotRoutes } from "./modules/shots/routes.js";
import { registerSessionRoutes } from "./modules/sessions/routes.js";
import { registerLibraryRoutes } from "./modules/library/routes.js";
import { registerProgressRoutes } from "./modules/progress/routes.js";
import { registerMediaRoutes } from "./modules/media/routes.js";
import { registerAnalysisRoutes } from "./modules/analysis/routes.js";
import { registerBillingRoutes } from "./modules/billing/routes.js";
import { registerSocialRoutes } from "./modules/social/routes.js";
import { registerPrivacyRoutes } from "./modules/privacy/routes.js";
import { registerConsentRoutes } from "./modules/consent/routes.js";
import { registerFlagRoutes } from "./modules/flags/routes.js";
import { registerAdminRoutes } from "./modules/admin/routes.js";
import { registerTrainingRoutes } from "./modules/training/routes.js";

/**
 * Modular-monolith API (directive §30). Modules communicate through typed
 * in-process services, never HTTP. Honesty rule: anything not implemented
 * returns a typed 501 envelope — never a fake success (directive §5).
 */

export interface BuildAppOptions {
  queue?: IJobQueue;
  objectStore?: IObjectStore | null;
  /** Operational telemetry sink; defaults to structured log lines. */
  analytics?: IAnalyticsSink;
}

export function buildApp(config: ApiConfig, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: config.env !== "test",
    genReqId: (req) => (req.headers["x-request-id"] as string | undefined) ?? randomUUID(),
  });

  const pool = config.databaseUrl ? new pg.Pool({ connectionString: config.databaseUrl }) : null;
  const queue =
    options.queue ??
    (config.sqsQueueUrl
      ? new SqsJobQueue({
          queueUrl: config.sqsQueueUrl,
          region: process.env["AWS_REGION"] ?? "us-west-2",
        })
      : new InMemoryJobQueue());
  const context: AppContext = {
    config,
    pool,
    queue,
    objectStore:
      options.objectStore !== undefined ? options.objectStore : buildObjectStore(process.env),
  };
  app.decorate("appContext", context);

  // Typed, privacy-safe api_failure telemetry: route TEMPLATE + method +
  // status + typed error code only — never the URL, body, or user identity.
  // 5xx are backend errors; 401/403 are the security-sensitive slice.
  const analytics =
    options.analytics ??
    new BufferedAnalytics(async (batch) => {
      for (const event of batch) app.log.info({ analyticsEvent: event }, "analytics");
    });
  app.addHook("onResponse", async (request, reply) => {
    const status = reply.statusCode;
    if (status >= 500 || status === 401 || status === 403) {
      analytics.track({
        name: "api_failure",
        at: new Date().toISOString(),
        platform: "service",
        route: request.routeOptions.url ?? "unmatched",
        method: request.method,
        statusCode: status,
        errorCode: failureCodeFor(reply) ?? "unknown",
      });
      await analytics.flush();
    }
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
  app.addHook("onClose", async () => {
    await pool?.end();
  });
  app.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 410) {
      return sendFailure(
        reply,
        request,
        410,
        "permanent",
        "account.deleted",
        "This account was deleted.",
      );
    }
    request.log.error({ err: error }, "unhandled error");
    return sendFailure(
      reply,
      request,
      500,
      "permanent",
      "api.internal_error",
      "Internal server error.",
    );
  });

  const verifier = buildVerifier({
    pickleEnv: config.env,
    oidcJwksUrl: config.oidcJwksUrl,
    oidcIssuer: config.oidcIssuer,
    oidcAudience: config.oidcAudience,
    devAuthSecret: config.devAuthSecret,
  });
  registerAuth(app, context, verifier);

  app.get("/v1/health", async () => ({ status: "ok" as const, version: config.appVersion }));
  app.get("/v1/openapi.json", async () => buildOpenApiDocument(config.appVersion));

  registerCatalogRoutes(app, context);
  registerCatalogExtraRoutes(app, context);
  registerIdentityRoutes(app, context);
  registerShotRoutes(app, context);
  registerSessionRoutes(app, context);
  registerLibraryRoutes(app, context);
  registerProgressRoutes(app, context);
  registerMediaRoutes(app, context);
  registerAnalysisRoutes(app, context);
  registerBillingRoutes(app, context);
  registerSocialRoutes(app, context);
  registerPrivacyRoutes(app, context);
  registerConsentRoutes(app, context);
  registerFlagRoutes(app, context);
  registerAdminRoutes(app, context);
  registerTrainingRoutes(app, context);

  return app;
}
