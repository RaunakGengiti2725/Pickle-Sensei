import type { FastifyInstance } from "fastify";
import { CheckpointsResponse, ShotTypesResponse } from "@pickle/api-contracts";
import type { AppContext } from "../../app.js";
import { sendFailure } from "../../app.js";

/**
 * Catalog module: public read-only shot type / checkpoint metadata.
 * DB-backed; when the database is unavailable the routes fail loudly with a
 * typed envelope — no fixture fallback in the API (directive §6).
 */

export function registerCatalogRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/v1/catalog/shot-types", async (request, reply) => {
    if (!context.pool) {
      return sendFailure(
        reply,
        request,
        503,
        "retryable",
        "catalog.db_unavailable",
        "Database not configured/reachable.",
      );
    }
    const { rows } = await context.pool.query(
      `SELECT id, slug, name, description, display_order, enabled
       FROM shot_type ORDER BY display_order`,
    );
    const payload = {
      items: rows.map((r: Record<string, unknown>) => ({
        id: r["id"],
        slug: r["slug"],
        name: r["name"],
        description: r["description"],
        displayOrder: r["display_order"],
        enabled: r["enabled"],
      })),
    };
    return ShotTypesResponse.parse(payload);
  });

  app.get("/v1/catalog/checkpoints", async (request, reply) => {
    if (!context.pool) {
      return sendFailure(
        reply,
        request,
        503,
        "retryable",
        "catalog.db_unavailable",
        "Database not configured/reachable.",
      );
    }
    const { rows } = await context.pool.query(
      `SELECT id, slug, name, description, display_order
       FROM checkpoint_definition ORDER BY display_order`,
    );
    const payload = {
      items: rows.map((r: Record<string, unknown>) => ({
        id: r["id"],
        slug: r["slug"],
        name: r["name"],
        description: r["description"],
        displayOrder: r["display_order"],
      })),
    };
    return CheckpointsResponse.parse(payload);
  });
}
