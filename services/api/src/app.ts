import { randomUUID } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import pg from "pg";
import { buildOpenApiDocument } from "@pickle/api-contracts";
import { InMemoryJobQueue, SqsJobQueue, type IJobQueue } from "@pickle/queue";
import { BufferedAnalytics, type IAnalyticsSink } from "@pickle/analytics";
import {
  ApiSloRecorder,
  evaluateApiSlos,
  DEFAULT_API_SLO_TARGETS,
  type PoolSaturationSample,
} from "@pickle/slo";
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
import { registerAnalysisReportRoutes } from "./modules/analysis/reportRoutes.js";
import { registerBillingRoutes } from "./modules/billing/routes.js";
import { registerSocialRoutes } from "./modules/social/routes.js";
import { registerPrivacyRoutes } from "./modules/privacy/routes.js";
import { registerConsentRoutes } from "./modules/consent/routes.js";
import { registerEvaluationRoutes } from "./modules/evaluation/routes.js";
import { registerFlagRoutes } from "./modules/flags/routes.js";
import { flagStateFingerprint } from "./modules/flags/registry.js";
import { registerAdminRoutes } from "./modules/admin/routes.js";
import { registerRollbackRoutes } from "./modules/admin/rollback.js";
import { registerQualityRoutes } from "./modules/quality/routes.js";
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
 * connection failure (08…), admin/crash shutdown, the server-side session
 * timeouts (idle_session_timeout 57P05, idle_in_transaction_session_timeout
 * 25P03 — both FATAL, the session is gone), and exhausted resources.
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
  "57P05",
  "25P03",
  "53300",
  "53400",
]);

/** pg's own messages for a socket that closed without a server error. */
const UNAVAILABLE_PG_MESSAGES = [
  "Connection terminated unexpectedly",
  "Connection terminated",
  "Client has encountered a connection error and is not queryable",
];

function isDatastoreUnavailable(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  if (typeof code === "string" && (UNAVAILABLE_SYSTEM_CODES.has(code) || code.startsWith("08")))
    return true;
  const message = error instanceof Error ? error.message : "";
  return UNAVAILABLE_PG_MESSAGES.includes(message) || message.startsWith("timeout exceeded");
}

function samplePool(pool: pg.Pool): PoolSaturationSample {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    maxSize: pool.options.max ?? null,
  };
}

/**
 * Connection pool whose client failures are operational telemetry, not
 * process faults. PostgreSQL closing a pooled connection (restart, failover,
 * session timeouts, pg_terminate_backend, a dropped socket) surfaces as an
 * 'error' event: pg-pool re-emits an IDLE client's error on the pool after
 * purging it, but detaches that listener while a client is CHECKED OUT
 * (`pool.connect()`), so a checked-out client emits on itself and would
 * otherwise be an unhandled 'error' event that ends the process. Every client
 * therefore carries a listener for the whole of its checkout (`acquire` →
 * `release`), attached synchronously at hand-out: the caller's `await
 * pool.connect()` resumes a microtask later, and a FATAL parsed from the same
 * socket chunk as the connection's ReadyForQuery lands before that. The
 * caller still sees its statements reject and decides what to answer. Each
 * failure is logged through the app logger — a warning for a recognised
 * datastore-unavailable class, an error otherwise — and the pool is sampled
 * into the SLO snapshot so the loss is visible on /v1/health/slo before any
 * request notices.
 */
function buildPool(
  connectionString: string,
  log: FastifyBaseLogger,
  sloRecorder: ApiSloRecorder,
): pg.Pool {
  const pool = new pg.Pool({ connectionString });
  const report = (err: Error, subject: string) => {
    // pg-pool tags the purged client onto the error; the log line must carry
    // the Postgres error, not a serialised socket and connection parameters.
    if ("client" in err) Object.defineProperty(err, "client", { enumerable: false });
    const pgCode = (err as { code?: string }).code ?? null;
    const sample = samplePool(pool);
    sloRecorder.recordPoolSample(sample);
    if (isDatastoreUnavailable(err)) {
      log.warn({ err, pgCode, pool: sample }, `postgres pool: ${subject} closed by server`);
      return;
    }
    log.error({ err, pgCode, pool: sample }, `postgres pool: ${subject} error`);
  };
  pool.on("error", (err) => report(err, "idle client"));
  const onCheckedOutClientError = (err: Error) => report(err, "checked-out client");
  pool.on("acquire", (client) => {
    client.on("error", onCheckedOutClientError);
  });
  pool.on("release", (_err, client) => {
    client.removeListener("error", onCheckedOutClientError);
  });
  return pool;
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
  /** Backend SLO recorder (availability, latency, 5xx, DB, pool). */
  sloRecorder?: ApiSloRecorder;
  /** Security-monitoring event sink; defaults to structured warn log lines. */
  securityEvents?: ISecurityEventSink;
}

export function buildApp(config: ApiConfig, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: config.env !== "test",
    genReqId: (req) => (req.headers["x-request-id"] as string | undefined) ?? randomUUID(),
  });

  const sloRecorder = options.sloRecorder ?? new ApiSloRecorder();
  const pool = config.databaseUrl ? buildPool(config.databaseUrl, app.log, sloRecorder) : null;
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

  const flagStateHash = flagStateFingerprint(process.env);
  app.addHook("onResponse", async (request, reply) => {
    const status = reply.statusCode;
    sloRecorder.recordRequest({
      route: request.routeOptions.url ?? "unmatched",
      statusCode: status,
      latencyMs: reply.elapsedTime,
    });
    if (status >= 500 || status === 401 || status === 403) {
      analytics.track({
        name: "api_failure",
        at: new Date().toISOString(),
        platform: "service",
        route: request.routeOptions.url ?? "unmatched",
        method: request.method,
        statusCode: status,
        errorCode: failureCodeFor(reply) ?? "unknown",
        flagStateHash,
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
  // Operational SLO surface: measured values plus a per-SLO verdict. A metric
  // that cannot be measured in this deployment reads not_evaluable — honest,
  // never a fabricated pass.
  app.get("/v1/health/slo", async () => {
    if (pool) {
      const started = process.hrtime.bigint();
      try {
        await pool.query("SELECT 1");
        sloRecorder.recordDbLatency(Number(process.hrtime.bigint() - started) / 1e6);
      } catch {
        // Probe failure surfaces through the datastore-unavailable 5xx path of
        // real requests; the probe itself must not throw the health route.
      }
      sloRecorder.recordPoolSample(samplePool(pool));
    }
    const snapshot = sloRecorder.snapshot();
    return {
      snapshot,
      evaluations: evaluateApiSlos(snapshot, DEFAULT_API_SLO_TARGETS),
      queueDepth: await queue.size(),
      queueOldestJobAgeMs: await queue.oldestJobAgeMs(),
    };
  });
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
  registerAnalysisReportRoutes(app, context);
  registerBillingRoutes(app, context);
  registerSocialRoutes(app, context);
  registerPrivacyRoutes(app, context);
  registerConsentRoutes(app, context);
  registerEvaluationRoutes(app, context);
  registerFlagRoutes(app, context);
  registerAdminRoutes(app, context);
  registerRollbackRoutes(app, context);
  registerQualityRoutes(app, context);
  registerTrainingRoutes(app, context);

  return app;
}
