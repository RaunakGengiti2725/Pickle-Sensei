import { createHash, createHmac } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { ConsentGrantRequest, ConsentWithdrawRequest } from "@pickle/api-contracts";
import {
  CONSENT_LEDGER_EXPORT_VERSION,
  CONSENT_LEDGER_EXPORT_VERSION_V2,
  canonicalConsentExportSigningPayload,
  canonicalConsentRecordsJson,
  checkConsentVersionAcceptable,
  deriveConsentStatus,
  type ConsentLedgerExport,
  type ConsentLedgerExportV2,
  type ConsentRecord,
} from "@pickle/shared-types";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { audit, many, one, withTransaction } from "../../lib/db.js";

/**
 * First-party consent module (STATUS_BOARD external blocker 3).
 * "Analyze my video" (video_analysis) and "use my video to improve models"
 * (model_training) are independent scopes. model_training is granted only by
 * an explicit request to this endpoint — nothing here or elsewhere defaults
 * it on. The ledger is append-only (DB trigger enforced): withdrawal appends
 * a state change and never deletes the audit trail. Records carry only a
 * pseudonym; the user mapping lives in consent_subject.
 */

interface ConsentRow extends Record<string, unknown> {
  id: string;
  seq: string;
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

function toRecord(row: ConsentRow): ConsentRecord {
  return {
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
    seq: Number(row.seq),
  };
}

async function pseudonymFor(db: pg.Pool | pg.PoolClient, userId: string): Promise<string> {
  const row = await one<{ pseudonym: string }>(
    db,
    `INSERT INTO consent_subject (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id = consent_subject.user_id
     RETURNING pseudonym`,
    [userId],
  );
  return row!.pseudonym;
}

async function statusPayload(db: pg.Pool | pg.PoolClient, pseudonym: string | null) {
  const records =
    pseudonym === null
      ? []
      : (
          await many<ConsentRow>(
            db,
            "SELECT * FROM consent_record WHERE subject_pseudonym = $1 ORDER BY seq",
            [pseudonym],
          )
        ).map(toRecord);
  return {
    subjectPseudonym: pseudonym,
    scopes: deriveConsentStatus(records).map((s) => ({
      scope: s.scope,
      active: s.active,
      consentVersion: s.consentVersion,
      lastAction: s.lastAction,
      lastActionAt: s.lastActionAtIso,
    })),
    records: records.map((r) => ({
      id: r.id,
      subjectPseudonym: r.subjectPseudonym,
      scope: r.scope,
      action: r.action,
      consentVersion: r.consentVersion,
      source: r.source,
      device: r.device,
      captureMode: r.captureMode,
      strokeIntent: r.strokeIntent,
      recordedAt: r.recordedAtIso,
      seq: r.seq,
    })),
  };
}

export function registerConsentRoutes(app: FastifyInstance, context: AppContext): void {
  const requireDb = (request: FastifyRequest, reply: FastifyReply): pg.Pool | null => {
    if (!context.pool) {
      void sendFailure(
        reply,
        request,
        503,
        "retryable",
        "consent.db_unavailable",
        "Consent ledger requires the database.",
      );
      return null;
    }
    return context.pool;
  };

  app.post("/v1/me/consent/grant", { preHandler: app.authenticate }, async (request, reply) => {
    const pool = requireDb(request, reply);
    if (!pool) return reply;
    const parsed = ConsentGrantRequest.safeParse(request.body);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.consent_grant",
        parsed.error.message,
      );
    const { scope, consentVersion, source, device, captureMode, strokeIntent } = parsed.data;
    const { decisionId, decidedAtIso } = parsed.data;
    const userId = request.user!.id;
    const outcome = await withTransaction(pool, async (tx) => {
      const p = await pseudonymFor(tx, userId);
      // Serialize per-subject writers so a concurrent grant/withdraw pair
      // resolves against the row the other one appended, not a stale read.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [p]);
      const latest = await one<{ action: ConsentRecord["action"]; recorded_at: Date }>(
        tx,
        `SELECT action, recorded_at FROM consent_record
         WHERE subject_pseudonym = $1 AND scope = $2
         ORDER BY seq DESC LIMIT 1`,
        [p, scope],
      );
      const latestGrant = await one<{ consent_version: string }>(
        tx,
        `SELECT consent_version FROM consent_record
         WHERE subject_pseudonym = $1 AND scope = $2 AND action = 'granted'
         ORDER BY seq DESC LIMIT 1`,
        [p, scope],
      );
      const versionCheck = checkConsentVersionAcceptable(
        scope,
        consentVersion,
        latestGrant?.consent_version ?? null,
      );
      if (!versionCheck.ok) {
        return { rejected: "version" as const, message: versionCheck.message! };
      }
      // A decision stamped before the scope's latest ledger action is a
      // replay of an old decision, not a new one: the later action (e.g. a
      // withdrawal) supersedes it and it must not resurrect consent.
      if (
        decidedAtIso !== undefined &&
        latest !== null &&
        Date.parse(decidedAtIso) < latest.recorded_at.getTime()
      ) {
        return { rejected: "stale" as const };
      }
      const inserted = await tx.query(
        `INSERT INTO consent_record
           (subject_pseudonym, scope, action, consent_version, source, device, capture_mode, stroke_intent, decision_id, decided_at)
         VALUES ($1, $2, 'granted', $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (decision_id) WHERE decision_id IS NOT NULL DO NOTHING`,
        [
          p,
          scope,
          consentVersion,
          source,
          device ?? null,
          captureMode,
          strokeIntent ?? null,
          decisionId ?? null,
          decidedAtIso ?? null,
        ],
      );
      if (inserted.rowCount === 0) {
        return { rejected: "replayed" as const };
      }
      await audit(tx, {
        actorUserId: userId,
        action: `consent.${scope}.granted`,
        targetKind: "consent_subject",
        targetId: p,
        requestId: request.id,
        metadata: { consentVersion, source },
      });
      return { rejected: null, pseudonym: p };
    });
    if (outcome.rejected === "version") {
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "consent.version_rejected",
        outcome.message,
      );
    }
    if (outcome.rejected === "stale") {
      return sendFailure(
        reply,
        request,
        409,
        "permanent",
        "consent.decision_stale",
        "This consent decision predates a later ledger action and cannot be applied.",
      );
    }
    if (outcome.rejected === "replayed") {
      return sendFailure(
        reply,
        request,
        409,
        "permanent",
        "consent.decision_replayed",
        "This consent decision was already recorded; a decisionId is single-use.",
      );
    }
    return statusPayload(pool, outcome.pseudonym);
  });

  app.post("/v1/me/consent/withdraw", { preHandler: app.authenticate }, async (request, reply) => {
    const pool = requireDb(request, reply);
    if (!pool) return reply;
    const parsed = ConsentWithdrawRequest.safeParse(request.body);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.consent_withdraw",
        parsed.error.message,
      );
    const { scope, source, device } = parsed.data;
    const userId = request.user!.id;
    const pseudonym = await withTransaction(pool, async (tx) => {
      const p = await pseudonymFor(tx, userId);
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [p]);
      const active = await one<{ consent_version: string }>(
        tx,
        `SELECT consent_version FROM consent_record
         WHERE subject_pseudonym = $1 AND scope = $2
         ORDER BY seq DESC LIMIT 1`,
        [p, scope],
      );
      await tx.query(
        `INSERT INTO consent_record
           (subject_pseudonym, scope, action, consent_version, source, device)
         VALUES ($1, $2, 'withdrawn', $3, $4, $5)`,
        [p, scope, active?.consent_version ?? "never_granted", source, device ?? null],
      );
      if (scope === "model_training") {
        // Withdrawal flags already-selected dataset items for removal review,
        // mirroring the privacy-center revocation path.
        await tx.query(
          "UPDATE ml_dataset_item SET removed_at = now() WHERE source_user_id = $1 AND removed_at IS NULL",
          [userId],
        );
        await tx.query(
          "INSERT INTO deletion_task (user_id, kind, detail) VALUES ($1, 'ml_dataset_review', '{}')",
          [userId],
        );
      }
      await audit(tx, {
        actorUserId: userId,
        action: `consent.${scope}.withdrawn`,
        targetKind: "consent_subject",
        targetId: p,
        requestId: request.id,
        metadata: { source },
      });
      return p;
    });
    return statusPayload(pool, pseudonym);
  });

  app.get("/v1/me/consent/status", { preHandler: app.authenticate }, async (request, reply) => {
    const pool = requireDb(request, reply);
    if (!pool) return reply;
    const row = await one<{ pseudonym: string }>(
      pool,
      "SELECT pseudonym FROM consent_subject WHERE user_id = $1",
      [request.user!.id],
    );
    return statusPayload(pool, row?.pseudonym ?? null);
  });

  // Canonical ledger export for intake hosts (first-party-intake consumes
  // exactly this envelope). Records are ConsentRecord-shaped (recordedAtIso,
  // seq required) and ordered by seq; the integrity fields let the consumer
  // detect truncated, reordered, or tampered exports offline.
  app.get("/v1/me/consent/export", { preHandler: app.authenticate }, async (request, reply) => {
    const pool = requireDb(request, reply);
    if (!pool) return reply;
    const userId = request.user!.id;
    const row = await one<{ pseudonym: string }>(
      pool,
      "SELECT pseudonym FROM consent_subject WHERE user_id = $1",
      [userId],
    );
    if (!row) {
      return sendFailure(
        reply,
        request,
        404,
        "permanent",
        "consent.no_ledger",
        "No consent ledger exists for this account.",
      );
    }
    const records = (
      await many<ConsentRow>(
        pool,
        "SELECT * FROM consent_record WHERE subject_pseudonym = $1 ORDER BY seq",
        [row.pseudonym],
      )
    ).map(toRecord);
    await audit(pool, {
      actorUserId: userId,
      action: "consent.ledger.exported",
      targetKind: "consent_subject",
      targetId: row.pseudonym,
      requestId: request.id,
      metadata: { recordCount: records.length },
    });
    const header = {
      exportedAtIso: new Date().toISOString(),
      subjectPseudonym: row.pseudonym,
      recordCount: records.length,
      maxSeq: records.length > 0 ? records.at(-1)!.seq! : null,
      recordsSha256: createHash("sha256")
        .update(canonicalConsentRecordsJson(records))
        .digest("hex"),
    };
    const signingKey = context.config.consentExportSigningKey;
    if (signingKey !== undefined) {
      const payload: ConsentLedgerExportV2 = {
        exportVersion: CONSENT_LEDGER_EXPORT_VERSION_V2,
        ...header,
        signature: {
          alg: "HMAC-SHA256",
          keyId: context.config.consentExportSigningKeyId,
          value: createHmac("sha256", signingKey)
            .update(
              canonicalConsentExportSigningPayload({
                exportVersion: CONSENT_LEDGER_EXPORT_VERSION_V2,
                ...header,
              }),
            )
            .digest("hex"),
        },
        records,
      };
      return payload;
    }
    const payload: ConsentLedgerExport = {
      exportVersion: CONSENT_LEDGER_EXPORT_VERSION,
      ...header,
      records,
    };
    return payload;
  });
}
