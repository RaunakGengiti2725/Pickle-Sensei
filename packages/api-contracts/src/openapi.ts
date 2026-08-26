import { z } from "zod";
import {
  CheckpointsResponse,
  ErrorEnvelope,
  HealthResponse,
  SessionCreateRequest,
  SessionResponse,
  ShotsSyncRequest,
  ShotsSyncResponse,
  ShotTypesResponse,
} from "./schemas.js";

/**
 * OpenAPI 3.1 document generated from the Zod schemas — the API's public
 * contract (directive §29). Endpoints not yet implemented are listed in
 * docs/API.md with status; only implemented routes appear here to keep the
 * document honest.
 */

function schema(s: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(s, { target: "draft-2020-12" }) as Record<string, unknown>;
}

const errorResponse = {
  description: "Typed error envelope",
  content: { "application/json": { schema: schema(ErrorEnvelope) } },
};

export function buildOpenApiDocument(apiVersion: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Pickle Sensei API",
      version: apiVersion,
      description: "REST /v1 API for the pickleball AI coaching platform.",
    },
    paths: {
      "/v1/health": {
        get: {
          operationId: "getHealth",
          summary: "Load-balancer health",
          responses: {
            "200": {
              description: "Service healthy",
              content: { "application/json": { schema: schema(HealthResponse) } },
            },
          },
        },
      },
      "/v1/catalog/shot-types": {
        get: {
          operationId: "listShotTypes",
          summary: "Supported strokes",
          responses: {
            "200": {
              description: "Shot type catalog",
              content: { "application/json": { schema: schema(ShotTypesResponse) } },
            },
            "500": errorResponse,
          },
        },
      },
      "/v1/catalog/checkpoints": {
        get: {
          operationId: "listCheckpoints",
          summary: "Checkpoint metadata",
          responses: {
            "200": {
              description: "Checkpoint catalog",
              content: { "application/json": { schema: schema(CheckpointsResponse) } },
            },
            "500": errorResponse,
          },
        },
      },
      "/v1/shots:sync": {
        post: {
          operationId: "syncShots",
          summary: "Upload on-device structured results (idempotent batch upsert)",
          requestBody: {
            required: true,
            content: { "application/json": { schema: schema(ShotsSyncRequest) } },
          },
          responses: {
            "200": {
              description: "Accepted/rejected ids",
              content: { "application/json": { schema: schema(ShotsSyncResponse) } },
            },
            "401": errorResponse,
            "501": errorResponse,
          },
        },
      },
      "/v1/sessions": {
        post: {
          operationId: "createSession",
          summary: "Create Live Court / guided session",
          requestBody: {
            required: true,
            content: { "application/json": { schema: schema(SessionCreateRequest) } },
          },
          responses: {
            "200": {
              description: "Session",
              content: { "application/json": { schema: schema(SessionResponse) } },
            },
            "401": errorResponse,
            "501": errorResponse,
          },
        },
      },
    },
  };
}
