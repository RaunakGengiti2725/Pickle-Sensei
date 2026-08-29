import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { buildOpenApiDocument } from "@pickle/api-contracts";
import { InMemoryJobQueue, SqsJobQueue, type IJobQueue } from "@pickle/queue";
import { BufferedAnalytics, type IAnalyticsSink } from "@pickle/analytics";
import type { FailureKind } from "@pickle/shared-types";
import type { ApiConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { failureCodeFor, sendFailure } from "./lib/replies.js";
import {
  classifySecurityEvent,
  PG_PRIVILEGE_ANOMALY_CODES,
  type ISecurityEventSink,
} from "./lib/securityEvents.js";
import { buildVerifier } from "./auth/tokens.js";
import { registerAuth } from "./plugins/authPlugin.js";
import {
  registerRateLimit,
  DEFAULT_RATE_LIMIT,
  type RateLimitConfig,
} from "./plugins/rateLimitPlugin.js";
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
import { registerEvaluationRoutes } from "./modules/evaluation/routes.js";
import { registerFlagRoutes } from "./modules/flags/routes.js";
import { registerAdminRoutes } from "./modules/admin/routes.js";
import { registerTrainingRoutes } from "./modules/training/routes.js";

/**
 * Modular-monolith API (directive §30). Modules communicate through typed
 * in-process services, never HTTP. Honesty rule: anything not implemented
 * returns a typed 501 envelope — never a fake success (directive §5).
 */

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Postgres invalid-input classes: invalid_text_representation (22P02),
 * numeric_value_out_of_range (22003), character_not_in_repertoire (22021) —
 * a bad identifier, number, or encoding reached SQL.
 */
const PG_INVALID_INPUT_CODES = new Set(["22P02", "22003", "22021"]);

/**
 * Datastore outages: connection refused/reset plus the Postgres classes for
 * connection failure (08…), admin shutdown, and exhausted resources.
 */
const UNAVAILABLE_SYSTEM_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "57P01",
  "57P02",
  "57P03",
  "53300",
  "53400",
]);

function isDatastoreUnavailable(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  if (typeof code === "string" && (UNAVAILABLE_SYSTEM_CODES.has(code) || code.startsWith("08")))
    return true;
  const message = error instanceof Error ? error.message : "";
  return message === "Connection terminated unexpectedly" || message.startsWith("timeout exceeded");
}

interface ClientFailure {
  status: number;
  kind: FailureKind;
  code: string;
  message: string;
}

/**
 * Maps request-level failures (bad JSON, wrong content type, oversized body,
 * unroutable identifiers) onto the typed 4xx envelope they deserve.
 */
function classifyClientFailure(
  error: unknown,
  statusCode: number | undefined,
): ClientFailure | null {
  const pgCode = (error as { code?: string }).code;
  if (typeof pgCode === "string" && PG_INVALID_INPUT_CODES.has(pgCode)) {
    return {
      status: 400,
      kind: "permanent",
      code: "validation.identifier",
      message: "A request value was not a valid identifier or number.",
    };
  }
  if (statusCode === undefined || statusCode < 400 || statusCode >= 500) return null;
  if (statusCode === 413) {
    return {
      status: 413,
      kind: "permanent",
      code: "validation.payload_too_large",
      message: "Request body is larger than the server accepts.",
    };
  }
  if (statusCode === 415) {
    return {
      status: 415,
      kind: "permanent",
      code: "validation.unsupported_media_type",
      message: "Request content type is not supported.",
    };
  }
  if (statusCode === 429) {
    return {
      status: 429,
      kind: "retryable",
      code: "api.rate_limited",
      message: "Too many requests. Retry later.",
    };
  }
  return {
    status: statusCode,
    kind: "permanent",
    code: "validation.request",
    message: "Request could not be parsed.",
  };
}

export interface BuildAppOptions {
  queue?: IJobQueue;
  objectStore?: IObjectStore | null;
  rateLimit?: Partial<RateLimitConfig>;
  /** Operational telemetry sink; defaults to structured log lines. */
  analytics?: IAnalyticsSink;
  /** Security-monitoring event sink; defaults to structured warn log lines. */
  securityEvents?: ISecurityEventSink;
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

  registerRateLimit(app, { ...DEFAULT_RATE_LIMIT, ...options.rateLimit });

  // NUL bytes are never valid in an identifier and cannot round-trip through
  // PostgreSQL text; they are rejected before any handler or log sees them.
  app.addHook("onRequest", async (request, reply) => {
    const rawUrl = request.raw.url ?? "";
    if (rawUrl.includes("%00") || rawUrl.includes("\u0000")) {
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.identifier",
        "Request path contains an illegal character.",
      );
    }
  });

  // Typed, privacy-safe api_failure telemetry: route TEMPLATE + method +
  // status + typed error code only — never the URL, body, or user identity.
  // 5xx are backend errors; 401/403 are the security-sensitive slice.
  const analytics =
    options.analytics ??
    new BufferedAnalytics(async (batch) => {
      for (const event of batch) app.log.info({ analyticsEvent: event }, "analytics");
    });
  // Typed security-monitoring events (auth anomalies, authorization denials,
  // admin anomalies, upload abuse, rate-limit trips, media-access failures,
  // consent mutations, training-eligibility changes). Same privacy contract
  // as api_failure: route template + typed code only, never URL/body/identity.
  const securityEvents: ISecurityEventSink = options.securityEvents ?? {
    record: (event) => app.log.warn({ securityEvent: event }, "security"),
  };
  app.addHook("onResponse", async (request, reply) => {
    const securityEvent = classifySecurityEvent({
      at: new Date().toISOString(),
      requestId: String(request.id),
      route: request.routeOptions.url ?? "unmatched",
      method: request.method,
      statusCode: reply.statusCode,
      errorCode: failureCodeFor(reply),
    });
    if (securityEvent) securityEvents.record(securityEvent);
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
  // Path ids are UUIDs everywhere. Rejecting a malformed one here keeps a
  // client typo out of the database and out of the 5xx error budget.
  app.addHook("preValidation", async (request, reply) => {
    const params = request.params as Record<string, unknown> | undefined;
    const id = params?.["id"];
    if (typeof id === "string" && !UUID_PATTERN.test(id)) {
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.path_id",
        "Path id must be a UUID.",
      );
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode;
    // The API role hitting a Postgres privilege wall means the
    // least-privilege grants drifted (or someone swapped credentials) —
    // record it as a security event before answering the client.
    const pgErrorCode = (error as { code?: string }).code;
    if (typeof pgErrorCode === "string" && PG_PRIVILEGE_ANOMALY_CODES.has(pgErrorCode)) {
      securityEvents.record({
        kind: "db_privilege_anomaly",
        at: new Date().toISOString(),
        requestId: String(request.id),
        route: request.routeOptions.url ?? "unmatched",
        method: request.method,
        statusCode: 500,
        errorCode: "api.internal_error",
        pgCode: pgErrorCode,
      });
      request.log.error({ pgCode: pgErrorCode }, "database privilege anomaly");
      return sendFailure(
        reply,
        request,
        500,
        "permanent",
        "api.internal_error",
        "Internal server error.",
      );
    }
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
    // A malformed request is the client's fault and must not be reported as an
    // internal failure: a 500 both misleads the app (permanent vs fixable) and
    // hides real server faults inside the noise of bad input.
    const clientFailure = classifyClientFailure(error, statusCode);
    if (clientFailure) {
      request.log.warn({ err: error }, "client request rejected");
      return sendFailure(
        reply,
        request,
        clientFailure.status,
        clientFailure.kind,
        clientFailure.code,
        clientFailure.message,
      );
    }
    // A datastore outage is transient: reporting it as permanent tells the app
    // to give up on queued work that would have synced after recovery.
    if (isDatastoreUnavailable(error)) {
      request.log.error({ err: error }, "datastore unavailable");
      return sendFailure(
        reply,
        request,
        503,
        "retryable",
        "api.datastore_unavailable",
        "The service is temporarily unavailable. Retry shortly.",
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
  registerEvaluationRoutes(app, context);
  registerFlagRoutes(app, context);
  registerAdminRoutes(app, context);
  registerTrainingRoutes(app, context);

  return app;
}
