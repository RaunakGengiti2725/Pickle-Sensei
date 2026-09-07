import type pg from "pg";
import type { IJobQueue, JobEnvelope } from "@pickle/queue";
import type { IAnalyticsSink } from "@pickle/analytics";
import type { QueueSloMonitor } from "@pickle/slo";
import {
  MEDIA_RETENTION_POLICY_V1,
  type MediaRetentionPolicy,
  type MediaRetentionRule,
} from "@pickle/shared-types";

/**
 * Media/maintenance worker (spec p. 38, directive §58).
 * Consumes: media.process, media.purge, share.render, analysis.deep, plus the
 * deletion_task table workflow. Every handler is explicit about what it can
 * and cannot do — no silent success.
 */

export interface ObjectDeleter {
  deleteObject(key: string): Promise<void>;
  /** Lists object keys under a prefix (derived artifacts live under `<masterKey>/`). */
  listObjects?(prefix: string): Promise<string[]>;
}

/** Deletes the master object and every derived artifact under its prefix. */
async function deleteObjectAndDerived(store: ObjectDeleter, objectKey: string): Promise<number> {
  let deleted = 0;
  if (store.listObjects) {
    for (const key of await store.listObjects(`${objectKey}/`)) {
      await store.deleteObject(key);
      deleted++;
    }
  }
  await store.deleteObject(objectKey);
  return deleted + 1;
}

/**
 * Deletion propagation to the training dataset: once a media asset is purged
 * (or its purge is being executed), any dataset item built from it — as source
 * clip or as derived feature asset — must stop being training-eligible.
 * Machine bookkeeping only; consent state is untouched.
 */
async function removeDatasetItemsForMedia(pool: pg.Pool, mediaAssetId: string): Promise<number> {
  const result = await pool.query(
    `UPDATE ml_dataset_item SET removed_at = COALESCE(removed_at, now())
     WHERE (media_asset_id = $1 OR feature_asset_id = $1) AND removed_at IS NULL`,
    [mediaAssetId],
  );
  return result.rowCount ?? 0;
}

export interface WorkerDeps {
  pool: pg.Pool;
  queue: IJobQueue;
  objectStore: ObjectDeleter | null;
  /** Transcode capability: null means ffmpeg unavailable → typed failure path. */
  transcoder:
    | ((input: { objectKey: string }) => Promise<{ normalizedKey: string; thumbnailKey: string }>)
    | null;
  log: (line: string) => void;
  /** Operational telemetry sink (worker_failure / queue_backlog). Optional:
   * absence means events are simply not emitted — behavior is unchanged. */
  analytics?: IAnalyticsSink;
  /** Stalled-queue detector; each runOnce cycle feeds it one observation. */
  sloMonitor?: QueueSloMonitor;
}

type JobOutcome = { handled: true; note: string } | { handled: false; note: string };

export async function handleJob(deps: WorkerDeps, job: JobEnvelope): Promise<JobOutcome> {
  switch (job.kind) {
    case "media.process": {
      const { mediaAssetId } = job.payload as { mediaAssetId: string };
      if (!deps.transcoder) {
        // No transcode capability configured: keep master playable as-is; the
        // asset is already 'ready' (API marks completion). Recorded honestly.
        await deps.pool.query(
          "UPDATE media_asset SET status = 'ready' WHERE id = $1 AND status IN ('processing','ready') AND deleted_at IS NULL",
          [mediaAssetId],
        );
        return { handled: true, note: "no transcoder configured; master kept as playback source" };
      }
      const asset = await deps.pool.query(
        "SELECT object_key, owner_user_id, deleted_at FROM media_asset WHERE id = $1",
        [mediaAssetId],
      );
      const row = asset.rows[0] as
        { object_key: string | null; owner_user_id: string; deleted_at: Date | null } | undefined;
      if (!row?.object_key)
        return { handled: false, note: `media_asset ${mediaAssetId} not found` };
      if (row.deleted_at) {
        // Deleted media must never be processed or resurrected.
        return {
          handled: true,
          note: `media_asset ${mediaAssetId} is deleted; processing refused`,
        };
      }
      const objectKey = row.object_key;
      let derived: { normalizedKey: string; thumbnailKey: string };
      try {
        derived = await deps.transcoder({ objectKey });
      } catch (error) {
        // Unsupported codec / corrupt file: typed failure, never a crash.
        await deps.pool.query(
          "UPDATE media_asset SET status = 'failed' WHERE id = $1 AND deleted_at IS NULL",
          [mediaAssetId],
        );
        return { handled: true, note: `transcode failed (asset marked failed): ${String(error)}` };
      }
      const prefix = `${objectKey}/`;
      if (!derived.normalizedKey.startsWith(prefix) || !derived.thumbnailKey.startsWith(prefix)) {
        // Derived artifacts must live under the master key so purge can find
        // them; otherwise they would be orphaned on deletion.
        if (deps.objectStore) {
          await deps.objectStore.deleteObject(derived.normalizedKey);
          await deps.objectStore.deleteObject(derived.thumbnailKey);
        }
        await deps.pool.query(
          "UPDATE media_asset SET status = 'failed' WHERE id = $1 AND deleted_at IS NULL",
          [mediaAssetId],
        );
        return {
          handled: true,
          note: "transcoder emitted derived keys outside the master prefix; artifacts removed, asset failed",
        };
      }
      const updated = await deps.pool.query(
        "UPDATE media_asset SET status = 'ready' WHERE id = $1 AND deleted_at IS NULL AND status <> 'deleted'",
        [mediaAssetId],
      );
      if (updated.rowCount === 0) {
        // Deleted mid-transcode: remove the derived artifacts we just created.
        if (deps.objectStore) {
          await deps.objectStore.deleteObject(derived.normalizedKey);
          await deps.objectStore.deleteObject(derived.thumbnailKey);
        }
        return {
          handled: true,
          note: `media_asset ${mediaAssetId} deleted mid-transcode; derived artifacts removed`,
        };
      }
      return {
        handled: true,
        note: `normalized=${derived.normalizedKey} thumb=${derived.thumbnailKey}`,
      };
    }

    case "media.purge": {
      const { mediaAssetId } = job.payload as { mediaAssetId: string };
      const asset = await deps.pool.query(
        "SELECT object_key, deleted_at FROM media_asset WHERE id = $1",
        [mediaAssetId],
      );
      const row = asset.rows[0] as
        { object_key: string | null; deleted_at: Date | null } | undefined;
      if (!row) return { handled: true, note: `media_asset ${mediaAssetId} not found` };
      if (!row.deleted_at) {
        // Never purge (or null the key of) a live asset.
        return { handled: true, note: `media_asset ${mediaAssetId} is not deleted; purge refused` };
      }
      const objectKey = row.object_key;
      if (!objectKey) return { handled: true, note: "no object to delete" };
      if (!deps.objectStore) {
        // Cannot reach object storage: keep the job visible, never pretend.
        return { handled: false, note: "object store unconfigured; purge left on queue" };
      }
      let deleted: number;
      try {
        deleted = await deleteObjectAndDerived(deps.objectStore, objectKey);
      } catch (error) {
        deps.analytics?.track({
          name: "media_storage_failure",
          at: new Date().toISOString(),
          platform: "service",
          operation: "purge",
        });
        return { handled: false, note: `object store purge failed: ${String(error)}` };
      }
      await deps.pool.query(
        "UPDATE media_asset SET object_key = NULL WHERE id = $1 AND deleted_at IS NOT NULL",
        [mediaAssetId],
      );
      const itemsRemoved = await removeDatasetItemsForMedia(deps.pool, mediaAssetId);
      return {
        handled: true,
        note: `object deleted (${deleted} artifact(s) incl. derived, ${itemsRemoved} dataset item(s) removed)`,
      };
    }

    case "share.render":
      // Rendering needs ffmpeg + template assets; fail visibly, keep queued state.
      return { handled: false, note: "share rendering requires ffmpeg pipeline (not configured)" };

    case "analysis.deep":
      return { handled: false, note: "cloud deep analysis requires the ml-worker deployment" };

    default:
      return { handled: false, note: `unknown job kind ${job.kind}` };
  }
}

export const DELETION_TASK_MAX_ATTEMPTS = 5;
export const DELETION_TASK_WINDOW = 20;

/** Deletion workflow executor (directive §58) — resumable, auditable. */
export async function processDeletionTasks(deps: WorkerDeps): Promise<number> {
  // 'processing' rows are picked up too: a worker crash mid-task must not
  // strand the deletion forever (every handler is idempotent). 'failed' rows
  // are retried up to the attempt cap so a transient storage/DB error cannot
  // permanently stall the account-deletion workflow; past the cap they stay
  // visibly 'failed'.
  // Round-robin: never-attempted rows first, then least recently attempted, so
  // held-back rows cannot fill the window every cycle and starve newer
  // deletions (every eligible row is tried once per ceil(n / WINDOW) cycles).
  const { rows } = await deps.pool.query(
    `SELECT id, user_id, kind FROM deletion_task
     WHERE status IN ('queued','processing')
        OR (status = 'failed' AND attempts < $1)
     ORDER BY last_attempt_at NULLS FIRST, created_at LIMIT $2`,
    [DELETION_TASK_MAX_ATTEMPTS, DELETION_TASK_WINDOW],
  );
  let processed = 0;
  for (const task of rows as Array<{ id: string; user_id: string; kind: string }>) {
    await deps.pool.query(
      "UPDATE deletion_task SET status = 'processing', last_attempt_at = clock_timestamp() WHERE id = $1",
      [task.id],
    );
    let note: Record<string, string> | null = null;
    try {
      switch (task.kind) {
        case "media_purge": {
          const assets = await deps.pool.query(
            "SELECT id, object_key FROM media_asset WHERE owner_user_id = $1 AND object_key IS NOT NULL",
            [task.user_id],
          );
          if (assets.rows.length > 0 && !deps.objectStore) {
            // Never claim purge is done while objects remain in the bucket:
            // that would let final_hard_delete proceed with data left behind.
            await deps.pool.query(
              "UPDATE deletion_task SET status = 'queued', detail = '{\"blocked\":\"object store unconfigured\"}' WHERE id = $1",
              [task.id],
            );
            continue;
          }
          for (const asset of assets.rows as Array<{ id: string; object_key: string }>) {
            await deleteObjectAndDerived(deps.objectStore!, asset.object_key);
            await deps.pool.query(
              "UPDATE media_asset SET object_key = NULL, status = 'deleted', deleted_at = COALESCE(deleted_at, now()) WHERE id = $1",
              [asset.id],
            );
          }
          break;
        }
        case "ml_dataset_review":
          await deps.pool.query(
            "UPDATE ml_dataset_item SET removed_at = COALESCE(removed_at, now()) WHERE source_user_id = $1",
            [task.user_id],
          );
          break;
        case "social_cleanup":
          await deps.pool.query(
            "DELETE FROM friendship WHERE requester_user_id = $1 OR addressee_user_id = $1",
            [task.user_id],
          );
          break;
        case "idp_revoke":
          // This worker holds no identity-provider admin credentials: the
          // step is terminal with the reason recorded in `detail`, never an
          // open row that outlives the account.
          note = { skipped: "idp credentials not configured" };
          break;
        case "final_hard_delete": {
          // Only when every other task for this user is done.
          // Other final_hard_delete rows for the same user are the same
          // terminal step (a duplicated enqueue), not outstanding work: were
          // they counted, each copy would wait on the others and the deletion
          // would stall forever.
          const pending = await deps.pool.query(
            "SELECT count(*)::int AS n FROM deletion_task WHERE user_id = $1 AND status NOT IN ('done') AND id <> $2 AND kind <> 'final_hard_delete'",
            [task.user_id, task.id],
          );
          if ((pending.rows[0]?.n ?? 1) > 0) {
            await deps.pool.query("UPDATE deletion_task SET status = 'queued' WHERE id = $1", [
              task.id,
            ]);
            continue;
          }
          // audit_log rows are retained (narrowly justified); app_user cascade
          // removes the remaining personal rows.
          await deps.pool.query("DELETE FROM app_user WHERE id = $1", [task.user_id]);
          break;
        }
        default:
          throw new Error(`unknown deletion task kind ${task.kind}`);
      }
      await deps.pool.query(
        "UPDATE deletion_task SET status = 'done', processed_at = now(), detail = COALESCE($2::jsonb, detail) WHERE id = $1",
        [task.id, note ? JSON.stringify(note) : null],
      );
      processed++;
    } catch (error) {
      deps.log(`deletion task ${task.id} failed: ${String(error)}`);
      await deps.pool.query(
        "UPDATE deletion_task SET status = 'failed', attempts = attempts + 1, detail = $2 WHERE id = $1",
        [task.id, JSON.stringify({ error: String(error) })],
      );
    }
  }
  return processed;
}

/**
 * Reconciliation sweep: any media row with deleted_at set but an object_key
 * still present is purged, so deletion completes even when the purge job was
 * lost (e.g. queue dispatch failed after the API committed the deletion).
 */
export async function sweepDeletedMedia(deps: WorkerDeps): Promise<number> {
  if (!deps.objectStore) return 0;
  const { rows } = await deps.pool.query(
    "SELECT id, object_key FROM media_asset WHERE deleted_at IS NOT NULL AND object_key IS NOT NULL LIMIT 50",
  );
  let swept = 0;
  for (const row of rows as Array<{ id: string; object_key: string }>) {
    // One failing object must not abort the whole sweep: log and move on so
    // the remaining rows still get purged; the failed row stays eligible for
    // the next sweep (object_key remains set).
    try {
      await deleteObjectAndDerived(deps.objectStore, row.object_key);
    } catch (error) {
      deps.log(`sweep of media_asset ${row.id} failed: ${String(error)}`);
      deps.analytics?.track({
        name: "media_storage_failure",
        at: new Date().toISOString(),
        platform: "service",
        operation: "sweep",
      });
      continue;
    }
    await deps.pool.query(
      "UPDATE media_asset SET object_key = NULL WHERE id = $1 AND deleted_at IS NOT NULL",
      [row.id],
    );
    await removeDatasetItemsForMedia(deps.pool, row.id);
    swept++;
  }
  return swept;
}

/**
 * Retention-policy enforcement sweep. Marks assets whose retention window has
 * elapsed as deleted; the deleted-media sweep (which runs after this in
 * runOnce) then purges the objects and removes dependent dataset items.
 * Precedence: an explicit per-asset expires_at always wins over the kind
 * rule; user_controlled kinds only expire when the OWNER opted into a
 * retention window (user_setting.local_video_retention_days > 0);
 * until_deleted kinds are never auto-expired.
 */
export async function enforceMediaRetention(
  deps: WorkerDeps,
  policy: MediaRetentionPolicy = MEDIA_RETENTION_POLICY_V1,
): Promise<number> {
  const expiredIds: string[] = [];
  const explicit = await deps.pool.query(
    `UPDATE media_asset SET status = 'deleted', deleted_at = now()
     WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= now()
     RETURNING id`,
  );
  for (const row of explicit.rows as Array<{ id: string }>) expiredIds.push(row.id);

  const ruleEntries = Object.entries(policy.rules) as Array<[string, MediaRetentionRule]>;
  const fixedWindowKinds = ruleEntries.filter(([, rule]) => rule.kind === "fixed_window");
  for (const [kind, rule] of fixedWindowKinds) {
    if (rule.kind !== "fixed_window") continue;
    const result = await deps.pool.query(
      `UPDATE media_asset SET status = 'deleted', deleted_at = now()
       WHERE deleted_at IS NULL AND expires_at IS NULL AND kind = $1
         AND created_at + make_interval(days => $2::int) <= now()
       RETURNING id`,
      [kind, rule.days],
    );
    for (const row of result.rows as Array<{ id: string }>) expiredIds.push(row.id);
  }

  const userControlledKinds = ruleEntries
    .filter(([, rule]) => rule.kind === "user_controlled")
    .map(([kind]) => kind);
  if (userControlledKinds.length > 0) {
    const result = await deps.pool.query(
      `UPDATE media_asset ma SET status = 'deleted', deleted_at = now()
       FROM user_setting us
       WHERE us.user_id = ma.owner_user_id
         AND ma.deleted_at IS NULL AND ma.expires_at IS NULL AND ma.kind = ANY($1::text[])
         AND us.local_video_retention_days IS NOT NULL AND us.local_video_retention_days > 0
         AND ma.created_at + make_interval(days => us.local_video_retention_days) <= now()
       RETURNING ma.id`,
      [userControlledKinds],
    );
    for (const row of result.rows as Array<{ id: string }>) expiredIds.push(row.id);
  }

  for (const id of expiredIds) {
    await deps.pool.query(
      `INSERT INTO audit_log (actor_service, action, target_kind, target_id, metadata)
       VALUES ('media-worker', 'media.retention_expired', 'media_asset', $1, $2)`,
      [id, JSON.stringify({ policyVersion: policy.version })],
    );
    try {
      await deps.queue.enqueue("media.purge", { mediaAssetId: id });
    } catch (error) {
      // Asset is already marked deleted; the deleted-media sweep purges it.
      deps.log(`media.purge dispatch for expired asset ${id} failed: ${String(error)}`);
    }
  }
  return expiredIds.length;
}

export async function runOnce(
  deps: WorkerDeps,
): Promise<{ jobs: number; deletions: number; swept: number; expired: number }> {
  const received = await deps.queue.receive(10);
  let jobs = 0;
  for (const { job, ack } of received) {
    let outcome: JobOutcome;
    let threw = false;
    try {
      outcome = await handleJob(deps, job);
    } catch (error) {
      // One poison job must never take down the batch: it stays on the queue
      // (visibility timeout) and the failure is logged loudly.
      threw = true;
      outcome = { handled: false, note: `handler threw: ${String(error)}` };
    }
    deps.log(`${job.kind}: ${outcome.note}`);
    if (!outcome.handled) {
      // Category only — the detailed note stays in the worker log, never in
      // analytics (it can carry error strings and object keys).
      deps.analytics?.track({
        name: "worker_failure",
        at: new Date().toISOString(),
        platform: "service",
        jobKind: job.kind,
        failureKind: threw ? "handler_exception" : "unhandled",
      });
    }
    if (outcome.handled) {
      await ack();
      jobs++;
    }
    // Unhandled jobs stay on the queue (visibility timeout) — visible backlog,
    // never silently dropped.
  }
  const deletions = await processDeletionTasks(deps);
  const expired = await enforceMediaRetention(deps);
  const swept = await sweepDeletedMedia(deps);
  const depth = await deps.queue.size();
  const oldestJobAgeMs = await deps.queue.oldestJobAgeMs();
  if (deps.analytics) {
    deps.analytics.track({
      name: "queue_backlog",
      at: new Date().toISOString(),
      platform: "service",
      queue: "media",
      depth,
      ...(oldestJobAgeMs !== null ? { oldestJobAgeMs } : {}),
    });
    const backlog = await deletionBacklog(deps.pool);
    if (backlog) {
      deps.analytics.track({
        name: "deletion_backlog",
        at: new Date().toISOString(),
        platform: "service",
        pending: backlog.pending,
        exhausted: backlog.exhausted,
        ...(backlog.oldestAgeSeconds !== null
          ? { oldestAgeSeconds: backlog.oldestAgeSeconds }
          : {}),
      });
    }
  }
  if (deps.sloMonitor) {
    const alert = deps.sloMonitor.observe({
      depth,
      oldestJobAgeMs,
      jobsHandled: jobs,
      jobsSeen: received.length,
    });
    if (alert) {
      // Loud by design: error-level log line plus a typed analytics alert.
      deps.log(
        `QUEUE STALLED (${alert.reason}): queue=${alert.queue} depth=${alert.depth} ` +
          `oldestJobAgeMs=${alert.oldestJobAgeMs ?? "unknown"} idleCycles=${alert.consecutiveIdleCycles}`,
      );
      deps.analytics?.track({
        name: "queue_stalled",
        at: new Date().toISOString(),
        platform: "service",
        queue: alert.queue,
        reason: alert.reason,
        depth: alert.depth,
        consecutiveIdleCycles: alert.consecutiveIdleCycles,
        ...(alert.oldestJobAgeMs !== null ? { oldestJobAgeMs: alert.oldestJobAgeMs } : {}),
      });
    }
  }
  await deps.analytics?.flush();
  return { jobs, deletions, swept, expired };
}

/**
 * Deletion-workflow backlog: rows not yet done, the age of the oldest one,
 * and rows failed past the retry cap (permanently stuck — needs a human).
 * Returns null when the table is unreachable; the caller's cycle-level error
 * handling makes that loud.
 */
export async function deletionBacklog(
  pool: pg.Pool,
): Promise<{ pending: number; oldestAgeSeconds: number | null; exhausted: number } | null> {
  try {
    const { rows } = await pool.query(
      `SELECT count(*) FILTER (WHERE status <> 'done')::int AS pending,
              floor(extract(epoch FROM now() - min(created_at) FILTER (WHERE status <> 'done')))::int AS oldest_age_seconds,
              count(*) FILTER (WHERE status = 'failed' AND attempts >= $1)::int AS exhausted
       FROM deletion_task`,
      [DELETION_TASK_MAX_ATTEMPTS],
    );
    const row = rows[0] as
      { pending: number; oldest_age_seconds: number | null; exhausted: number } | undefined;
    if (!row) return null;
    return {
      pending: row.pending,
      oldestAgeSeconds: row.oldest_age_seconds,
      exhausted: row.exhausted,
    };
  } catch {
    return null;
  }
}
