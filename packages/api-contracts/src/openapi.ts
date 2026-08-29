import { z } from "zod";
import {
  AccessStateSchema,
  AnalysisPermitFinalizeRequest,
  AnalysisPermitReserveRequest,
  AnalysisPermitResponse,
  CheckpointsResponse,
  ErrorEnvelope,
  HealthResponse,
  SessionCreateRequest,
  SessionResponse,
  ShotsSyncRequest,
  ShotsSyncResponse,
  ShotTypesResponse,
  RevenueCatSyncResponse,
  TrainingPlanCreateRequest,
  TrainingPlanResponse,
  TrainingPlanReassessmentRequest,
  DrillCompletionCreateRequest,
  ConsentGrantRequest,
  ConsentLedgerExportResponse,
  ConsentWithdrawRequest,
  ConsentStatusResponse,
  QualityDashboardResponse,
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
          summary: "Atomically persist permit-bound results and consume only successful ratings",
          description:
            "Each result carries its pre-inference analysis permit. The shot insert and permit finalization are one transaction. Replays are accepted only when user, shot, permit, and outcome match the original write.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: schema(ShotsSyncRequest) } },
          },
          responses: {
            "200": {
              description: "Accepted/rejected ids",
              content: { "application/json": { schema: schema(ShotsSyncResponse) } },
            },
            "400": errorResponse,
            "401": errorResponse,
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
      "/v1/training-plans": {
        post: {
          operationId: "createTrainingPlan",
          summary: "Create an evidence-backed deterministic plan from a scored shot",
          requestBody: {
            required: true,
            content: { "application/json": { schema: schema(TrainingPlanCreateRequest) } },
          },
          responses: {
            "200": {
              description: "Persisted training plan",
              content: { "application/json": { schema: schema(TrainingPlanResponse) } },
            },
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/v1/training-plans/current": {
        get: {
          operationId: "getCurrentTrainingPlan",
          summary: "Get the athlete's current real training plan",
          responses: {
            "200": {
              description: "Current plan or null when none exists",
              content: { "application/json": { schema: schema(TrainingPlanResponse) } },
            },
            "401": errorResponse,
          },
        },
      },
      "/v1/training-plans/{id}/reassessment": {
        post: {
          operationId: "completeTrainingPlanReassessment",
          summary: "Link a newer scored shot and compute version-compatible improvement",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: schema(TrainingPlanReassessmentRequest) } },
          },
          responses: {
            "200": {
              description: "Completed training plan",
              content: { "application/json": { schema: schema(TrainingPlanResponse) } },
            },
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
            "422": errorResponse,
          },
        },
      },
      "/v1/drill-completions": {
        post: {
          operationId: "recordDrillCompletion",
          summary: "Record actual reps or duration and derive streak qualification server-side",
          requestBody: {
            required: true,
            content: { "application/json": { schema: schema(DrillCompletionCreateRequest) } },
          },
          responses: {
            "200": { description: "Persisted completion" },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/v1/me/consent/grant": {
        post: {
          operationId: "grantConsent",
          summary:
            "Append a scoped consent grant to the immutable ledger (model_training is explicit opt-in, never a default)",
          requestBody: {
            required: true,
            content: { "application/json": { schema: schema(ConsentGrantRequest) } },
          },
          responses: {
            "200": {
              description: "Updated consent status",
              content: { "application/json": { schema: schema(ConsentStatusResponse) } },
            },
            "400": errorResponse,
            "401": errorResponse,
          },
        },
      },
      "/v1/me/consent/withdraw": {
        post: {
          operationId: "withdrawConsent",
          summary:
            "Append a withdrawal — an append-only state change that never deletes the audit trail",
          requestBody: {
            required: true,
            content: { "application/json": { schema: schema(ConsentWithdrawRequest) } },
          },
          responses: {
            "200": {
              description: "Updated consent status",
              content: { "application/json": { schema: schema(ConsentStatusResponse) } },
            },
            "400": errorResponse,
            "401": errorResponse,
          },
        },
      },
      "/v1/me/consent/status": {
        get: {
          operationId: "getConsentStatus",
          summary: "Derived per-scope consent status plus the full ledger",
          responses: {
            "200": {
              description: "Consent status",
              content: { "application/json": { schema: schema(ConsentStatusResponse) } },
            },
            "401": errorResponse,
          },
        },
      },
      "/v1/me/consent/export": {
        get: {
          operationId: "exportConsentLedger",
          summary:
            "Canonical consent ledger export for intake hosts — versioned envelope with integrity fields (recordCount, maxSeq, recordsSha256)",
          responses: {
            "200": {
              description: "Consent ledger export envelope",
              content: { "application/json": { schema: schema(ConsentLedgerExportResponse) } },
            },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/v1/me/access": {
        get: {
          operationId: "getMyAccess",
          summary: "Canonical premium entitlement and lifetime free-rating allowance",
          responses: {
            "200": {
              description: "Current access state",
              content: { "application/json": { schema: schema(AccessStateSchema) } },
            },
            "401": errorResponse,
          },
        },
      },
      "/v1/analysis-permits": {
        post: {
          operationId: "reserveAnalysisPermit",
          summary: "Idempotently reserve access for one rating",
          requestBody: {
            required: true,
            content: { "application/json": { schema: schema(AnalysisPermitReserveRequest) } },
          },
          responses: {
            "200": {
              description: "Reserved or previously returned permit",
              content: { "application/json": { schema: schema(AnalysisPermitResponse) } },
            },
            "402": errorResponse,
            "401": errorResponse,
          },
        },
      },
      "/v1/analysis-permits/{id}/finalize": {
        post: {
          operationId: "finalizeAnalysisPermit",
          summary: "Consume only a successful rating; release all abstentions and failures",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: schema(AnalysisPermitFinalizeRequest) } },
          },
          responses: {
            "200": {
              description: "Finalized permit and current access state",
              content: { "application/json": { schema: schema(AnalysisPermitResponse) } },
            },
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/v1/billing/sync": {
        post: {
          operationId: "syncRevenueCatBilling",
          summary: "Refresh canonical billing state from RevenueCat's server API",
          responses: {
            "200": {
              description: "Server-verified billing and access state",
              content: { "application/json": { schema: schema(RevenueCatSyncResponse) } },
            },
            "401": errorResponse,
            "503": errorResponse,
          },
        },
      },
      "/v1/admin/quality-dashboard": {
        get: {
          operationId: "getQualityDashboard",
          summary: "Aggregate production quality metrics (admin-only, audited)",
          parameters: [
            {
              name: "windowDays",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 90, default: 7 },
            },
          ],
          responses: {
            "200": {
              description: "Aggregate quality metrics; counts only, never raw private media",
              content: { "application/json": { schema: schema(QualityDashboardResponse) } },
            },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "503": errorResponse,
          },
        },
      },
    },
  };
}
