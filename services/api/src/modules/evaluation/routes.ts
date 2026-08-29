import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { EvaluationTrialUploadRequest } from "@pickle/api-contracts";
import {
  isEvaluationTelemetryConsentActive,
  validateEvaluationTrial,
  type ConsentRecord,
} from "@pickle/shared-types";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { audit, many, one, withTransaction } from "../../lib/db.js";

/**
 * Evaluation-trial intake (Wave G2 h07). Devices upload per-trial evidence —
 * what the product claimed, what it abstained from, what the user flagged —
 * only while the subject's `evaluation_telemetry` consent is ACTIVE in the
 * server ledger (the client's opinion of its own consent is never trusted).
 * Rows are append-only claims for offline labeling; the server never stores
 * or accepts a correctness/silent-failure verdict from a device.
 */

interface ConsentScopeRow extends Record<string, unknown> {
  id: string;
  subject_pseudonym: string;
  scope: ConsentRecord["scope"];
  action: ConsentRecord["action"];
  consent_version: string;
  source: ConsentRecord["source"];
  device: string | null;
  capture_mode: ConsentRecord["captureMode"];
  stroke_intent: string | null;
  recorded_at: Date;
}

export function registerEvaluationRoutes(app: FastifyInstance, context: AppContext): void {
  const requireDb = (request: FastifyRequest, reply: FastifyReply): pg.Pool | null => {
    if (!context.pool) {
      void sendFailure(
        reply,
        request,
        503,
        "retryable",
        "evaluation.db_unavailable",
        "Evaluation trial intake requires the database.",
      );
      return null;
    }
    return context.pool;
  };

  app.post("/v1/me/evaluation/trials", { preHandler: app.authenticate }, async (request, reply) => {
    const pool = requireDb(request, reply);
    if (!pool) return reply;
    const parsed = EvaluationTrialUploadRequest.safeParse(request.body);
    if (!parsed.success) {
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.evaluation_trials",
        parsed.error.message,
      );
    }
    const userId = request.user!.id;
    const subject = await one<{ pseudonym: string }>(
      pool,
      "SELECT pseudonym FROM consent_subject WHERE user_id = $1",
      [userId],
    );
    const ledger =
      subject === null
        ? []
        : (
            await many<ConsentScopeRow>(
              pool,
              "SELECT * FROM consent_record WHERE subject_pseudonym = $1 ORDER BY seq",
              [subject.pseudonym],
            )
          ).map((row): ConsentRecord => ({
            id: row.id,
            subjectPseudonym: row.subject_pseudonym,
            scope: row.scope,
            action: row.action,
            consentVersion: row.consent_version,
            source: row.source,
            device: row.device,
            captureMode: row.capture_mode,
            strokeIntent: row.stroke_intent,
            recordedAtIso: row.recorded_at.toISOString(),
          }));
    if (subject === null || !isEvaluationTelemetryConsentActive(ledger)) {
      return sendFailure(
        reply,
        request,
        403,
        "permanent",
        "evaluation.consent_inactive",
        "evaluation_telemetry consent is not active for this account; trials are not accepted.",
      );
    }
    const acceptedTrialIds: string[] = [];
    const rejected: Array<{ trialId: string; code: string; message: string }> = [];
    await withTransaction(pool, async (tx) => {
      for (const trial of parsed.data.trials) {
        const verdict = validateEvaluationTrial(trial);
        if (!verdict.ok) {
          rejected.push({
            trialId: String(trial.trialId ?? "unknown"),
            code: "evaluation.trial_invalid",
            message: verdict.errors.slice(0, 5).join("; "),
          });
          continue;
        }
        // trialId is client-generated and idempotent: a retried upload of the
        // same trial is acknowledged, never duplicated.
        const inserted = await tx.query(
          `INSERT INTO evaluation_trial
             (trial_id, subject_pseudonym, schema_version, consent_version, captured_at, record)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (trial_id) DO NOTHING`,
          [
            trial.trialId,
            subject.pseudonym,
            trial.schemaVersion,
            trial.consent.consentVersion,
            trial.capturedAtIso,
            JSON.stringify(trial),
          ],
        );
        if (inserted.rowCount === 0) {
          const existing = await one<{ subject_pseudonym: string }>(
            tx,
            "SELECT subject_pseudonym FROM evaluation_trial WHERE trial_id = $1",
            [trial.trialId],
          );
          if (existing !== null && existing.subject_pseudonym !== subject.pseudonym) {
            rejected.push({
              trialId: trial.trialId,
              code: "evaluation.trial_id_conflict",
              message: "This trialId was already recorded for a different subject.",
            });
            continue;
          }
        }
        acceptedTrialIds.push(trial.trialId);
      }
      await audit(tx, {
        actorUserId: userId,
        action: "evaluation.trials.uploaded",
        targetKind: "consent_subject",
        targetId: subject.pseudonym,
        requestId: request.id,
        metadata: { accepted: acceptedTrialIds.length, rejected: rejected.length },
      });
    });
    return { acceptedTrialIds, rejected };
  });
}
