import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import pg from "pg";
import { buildOpenApiDocument } from "@pickle/api-contracts";
import type { FailureKind } from "@pickle/shared-types";
import type { ApiConfig } from "./config.js";
import { registerCatalogRoutes } from "./modules/catalog/routes.js";

/**
 * Modular-monolith API (directive §30). Modules register their routes here;
 * cross-module calls go through typed service interfaces, not HTTP.
 *
 * Honesty rule: routes that are specified but not yet implemented return a
 * typed 501 envelope — never a fake success (directive §5).
 */

export interface AppContext {
  config: ApiConfig;
  pool: pg.Pool | null;
}

export function sendFailure(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  kind: FailureKind,
  code: string,
  message: string,
): FastifyReply {
  return reply.status(status).send({
    error: {
      kind,
      code,
      message,
      retryable: kind === "timeout" || kind === "retryable" || kind === "network",
      requestId: request.id,
    },
  });
}

function registerNotImplemented(app: FastifyInstance, method: "GET" | "POST", url: string): void {
  app.route({
    method,
    url,
    handler: (request, reply) =>
      sendFailure(
        reply,
        request,
        501,
        "not_implemented",
        "api.not_implemented",
        `${method} ${url} is specified (docs/API.md) but not implemented yet.`,
      ),
  });
}

export function buildApp(config: ApiConfig): FastifyInstance {
  const app = Fastify({
    logger: config.env !== "test",
    genReqId: (req) => (req.headers["x-request-id"] as string | undefined) ?? randomUUID(),
  });

  const pool = config.databaseUrl ? new pg.Pool({ connectionString: config.databaseUrl }) : null;
  const context: AppContext = { config, pool };
  app.decorate("appContext", context);

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.addHook("onClose", async () => {
    await pool?.end();
  });

  app.setErrorHandler((error, request, reply) => {
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

  // ── health ────────────────────────────────────────────────────────────────
  app.get("/v1/health", async () => ({ status: "ok" as const, version: config.appVersion }));

  // ── OpenAPI (implemented surface only) ────────────────────────────────────
  app.get("/v1/openapi.json", async () => buildOpenApiDocument(config.appVersion));

  // ── catalog (DB-backed) ───────────────────────────────────────────────────
  registerCatalogRoutes(app, context);

  // ── specified but pending (each returns a typed 501, never fake success) ──
  registerNotImplemented(app, "POST", "/v1/account/bootstrap");
  registerNotImplemented(app, "GET", "/v1/me");
  registerNotImplemented(app, "POST", "/v1/shots:sync");
  registerNotImplemented(app, "POST", "/v1/sessions");
  registerNotImplemented(app, "POST", "/v1/media/uploads");
  registerNotImplemented(app, "POST", "/v1/analyses");

  return app;
}
