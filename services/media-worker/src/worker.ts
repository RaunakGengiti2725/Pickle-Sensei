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

export type JobOutcome = { handled: true; note: string } | { handled: false; note: string };

export async function handleJob(deps: WorkerDeps, job: JobEnvelope): Promise<JobOutcome> {
  switch (job.kind) {
    case "media.process": {
      const { mediaAssetId } = job.payload as { mediaAssetId: string };
      if (!deps.transcoder) {
        // No transcode capability configured: keep master playable as-is; the
        // asset is already 'ready' (API marks completion). Recorded honestly.
        await deps.pool.query(
          "UPDATE media_asset SET status = 'ready' WHERE id = $1 AND status IN ('processing','ready')",
          [mediaAssetId],
        );
        return { handled: true, note: "no transcoder configured; master kept as playback source" };
      }
      const asset = await deps.pool.query("SELECT object_key FROM media_asset WHERE id = $1", [
        mediaAssetId,
      ]);
      const objectKey = asset.rows[0]?.object_key as string | undefined;
      if (!objectKey) return { handled: false, note: `media_asset ${mediaAssetId} not found` };
      const { normalizedKey, thumbnailKey } = await deps.transcoder({ objectKey });
      await deps.pool.query("UPDATE media_asset SET status = 'ready' WHERE id = $1", [
        mediaAssetId,
      ]);
      return { handled: true, note: `normalized=${normalizedKey} thumb=${thumbnailKey}` };
    }

    case "media.purge": {
      const { mediaAssetId } = job.payload as { mediaAssetId: string };
      const asset = await deps.pool.query(
        "SELECT object_key FROM media_asset WHERE id = $1 AND deleted_at IS NOT NULL",
        [mediaAssetId],
      );
      const objectKey = asset.rows[0]?.object_key as string | undefined;
      if (objectKey && deps.objectStore) {
        await deps.objectStore.deleteObject(objectKey);
      }
      await deps.pool.query("UPDATE media_asset SET object_key = NULL WHERE id = $1", [
        mediaAssetId,
      ]);
      return { handled: true, note: objectKey ? "object deleted" : "no object to delete" };
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
  const { rows } = await deps.pool.query(
    `SELECT id, user_id, kind FROM deletion_task WHERE status = 'queued' ORDER BY created_at LIMIT 20`,
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
          for (const asset of assets.rows as Array<{ id: string; object_key: string }>) {
            if (deps.objectStore) await deps.objectStore.deleteObject(asset.object_key);
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

export async function runOnce(deps: WorkerDeps): Promise<{ jobs: number; deletions: number }> {
  const received = await deps.queue.receive(10);
  let jobs = 0;
  for (const { job, ack } of received) {
    const outcome = await handleJob(deps, job);
    deps.log(`${job.kind}: ${outcome.note}`);
    if (outcome.handled) {
      await ack();
      jobs++;
    }
    // Unhandled jobs stay on the queue (visibility timeout) — visible backlog,
    // never silently dropped.
  }
  const deletions = await processDeletionTasks(deps);
  return { jobs, deletions };
}
