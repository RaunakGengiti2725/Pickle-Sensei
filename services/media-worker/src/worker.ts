import type pg from "pg";
import type { IJobQueue, JobEnvelope } from "@pickle/queue";

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

export interface WorkerDeps {
  pool: pg.Pool;
  queue: IJobQueue;
  objectStore: ObjectDeleter | null;
  /** Transcode capability: null means ffmpeg unavailable → typed failure path. */
  transcoder:
    | ((input: { objectKey: string }) => Promise<{ normalizedKey: string; thumbnailKey: string }>)
    | null;
  log: (line: string) => void;
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
      const deleted = await deleteObjectAndDerived(deps.objectStore, objectKey);
      await deps.pool.query(
        "UPDATE media_asset SET object_key = NULL WHERE id = $1 AND deleted_at IS NOT NULL",
        [mediaAssetId],
      );
      return { handled: true, note: `object deleted (${deleted} artifact(s) incl. derived)` };
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

/** Deletion workflow executor (directive §58) — resumable, auditable. */
export async function processDeletionTasks(deps: WorkerDeps): Promise<number> {
  // 'processing' rows are picked up too: a worker crash mid-task must not
  // strand the deletion forever (every handler is idempotent).
  const { rows } = await deps.pool.query(
    `SELECT id, user_id, kind FROM deletion_task WHERE status IN ('queued','processing') ORDER BY created_at LIMIT 20`,
  );
  let processed = 0;
  for (const task of rows as Array<{ id: string; user_id: string; kind: string }>) {
    await deps.pool.query("UPDATE deletion_task SET status = 'processing' WHERE id = $1", [
      task.id,
    ]);
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
          // Requires identity-provider admin credentials; keep queued visibly.
          await deps.pool.query(
            "UPDATE deletion_task SET status = 'queued', detail = '{\"blocked\":\"idp credentials not configured\"}' WHERE id = $1",
            [task.id],
          );
          continue;
        case "final_hard_delete": {
          // Only when every other task for this user is done.
          const pending = await deps.pool.query(
            "SELECT count(*)::int AS n FROM deletion_task WHERE user_id = $1 AND status NOT IN ('done') AND id <> $2 AND kind <> 'idp_revoke'",
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
        "UPDATE deletion_task SET status = 'done', processed_at = now() WHERE id = $1",
        [task.id],
      );
      processed++;
    } catch (error) {
      deps.log(`deletion task ${task.id} failed: ${String(error)}`);
      await deps.pool.query(
        "UPDATE deletion_task SET status = 'failed', detail = $2 WHERE id = $1",
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
    await deleteObjectAndDerived(deps.objectStore, row.object_key);
    await deps.pool.query(
      "UPDATE media_asset SET object_key = NULL WHERE id = $1 AND deleted_at IS NOT NULL",
      [row.id],
    );
    swept++;
  }
  return swept;
}

export async function runOnce(
  deps: WorkerDeps,
): Promise<{ jobs: number; deletions: number; swept: number }> {
  const received = await deps.queue.receive(10);
  let jobs = 0;
  for (const { job, ack } of received) {
    let outcome: JobOutcome;
    try {
      outcome = await handleJob(deps, job);
    } catch (error) {
      // One poison job must never take down the batch: it stays on the queue
      // (visibility timeout) and the failure is logged loudly.
      outcome = { handled: false, note: `handler threw: ${String(error)}` };
    }
    deps.log(`${job.kind}: ${outcome.note}`);
    if (outcome.handled) {
      await ack();
      jobs++;
    }
    // Unhandled jobs stay on the queue (visibility timeout) — visible backlog,
    // never silently dropped.
  }
  const deletions = await processDeletionTasks(deps);
  const swept = await sweepDeletedMedia(deps);
  return { jobs, deletions, swept };
}
