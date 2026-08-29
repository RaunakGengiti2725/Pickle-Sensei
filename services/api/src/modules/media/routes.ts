import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { audit, one } from "../../lib/db.js";

/**
 * Media module (spec p. 38): presigned direct-to-S3 uploads, private storage,
 * short-lived signed playback URLs, real deletion queued through the worker.
 * Video never flows through the API server.
 */

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // strict video limit (spec p. 41)
const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES_BY_KIND: Record<string, Set<string>> = {
  raw_video: new Set(["video/mp4", "video/quicktime"]),
  thumbnail: new Set(["image/jpeg", "image/webp"]),
};
const MAX_BYTES_BY_KIND: Record<string, number> = {
  raw_video: MAX_UPLOAD_BYTES,
  thumbnail: MAX_THUMBNAIL_BYTES,
};

const UploadCreate = z.object({
  kind: z.enum(["raw_video", "thumbnail"]),
  filename: z.string().max(200),
  bytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  contentType: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export function registerMediaRoutes(app: FastifyInstance, context: AppContext): void {
  app.post("/v1/media/uploads", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = UploadCreate.safeParse(request.body);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.upload",
        parsed.error.message,
      );
    const body = parsed.data;
    if (!ALLOWED_CONTENT_TYPES_BY_KIND[body.kind]!.has(body.contentType)) {
      return sendFailure(
        reply,
        request,
        422,
        "corrupted_media",
        "media.unsupported_type",
        `Content type ${body.contentType} not allowed for kind ${body.kind}.`,
      );
    }
    if (body.bytes > MAX_BYTES_BY_KIND[body.kind]!) {
      return sendFailure(
        reply,
        request,
        422,
        "corrupted_media",
        "media.too_large",
        `Declared size ${body.bytes} exceeds the ${body.kind} limit.`,
      );
    }
    const userId = request.user!.id;
    // Privacy gate first (spec §34): consent decides before infrastructure does.
    const settings = await one<{ cloud_sync_enabled: boolean }>(
      context.pool!,
      "SELECT cloud_sync_enabled FROM user_setting WHERE user_id = $1",
      [userId],
    );
    if (!settings?.cloud_sync_enabled) {
      return sendFailure(
        reply,
        request,
        403,
        "permission_denied",
        "media.cloud_sync_disabled",
        "Cloud video sync is disabled in your privacy settings.",
      );
    }
    if (!context.objectStore) {
      return sendFailure(
        reply,
        request,
        503,
        "retryable",
        "media.storage_unconfigured",
        "Object storage not configured.",
      );
    }
    // Random opaque object key — never derived from user data (spec p. 41).
    const objectKey = `media/${userId}/${randomBytes(24).toString("hex")}`;
    const asset = await one<{ id: string }>(
      context.pool!,
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, content_type, size_bytes, sha256, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'uploading') RETURNING id`,
      [
        userId,
        body.kind,
        context.objectStore.bucket,
        objectKey,
        body.contentType,
        body.bytes,
        body.sha256,
      ],
    );
    const uploadUrl = await context.objectStore.presignUpload(objectKey, body.contentType, 900);
    return { mediaAssetId: asset!.id, uploadUrl, expiresSeconds: 900 };
  });

  app.post("/v1/media/:id/complete", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pending = await one<{ object_key: string; size_bytes: string | number }>(
      context.pool!,
      "SELECT object_key, size_bytes FROM media_asset WHERE id = $1 AND owner_user_id = $2 AND status = 'uploading' AND deleted_at IS NULL",
      [id, request.user!.id],
    );
    if (!pending)
      return sendFailure(
        reply,
        request,
        404,
        "permanent",
        "media.not_found",
        "Upload not found or already completed.",
      );
    if (context.objectStore) {
      const head = await context.objectStore.headObject(pending.object_key);
      if (!head) {
        return sendFailure(
          reply,
          request,
          422,
          "corrupted_media",
          "media.object_missing",
          "No uploaded object was found for this asset.",
        );
      }
      if (head.sizeBytes > Number(pending.size_bytes) || head.sizeBytes > MAX_UPLOAD_BYTES) {
        // Reject and queue purge of the offending object — never keep it.
        await context.pool!.query(
          "UPDATE media_asset SET status = 'deleted', deleted_at = now() WHERE id = $1",
          [id],
        );
        try {
          await context.queue.enqueue("media.purge", { mediaAssetId: id });
        } catch (error) {
          // Asset is marked deleted; the worker sweep will purge the object.
          request.log.error({ err: error }, "media.purge dispatch failed; sweep will purge");
        }
        return sendFailure(
          reply,
          request,
          422,
          "corrupted_media",
          "media.size_exceeded",
          `Uploaded object is ${head.sizeBytes} bytes, larger than the declared/allowed size.`,
        );
      }
    }
    const result = await context.pool!.query(
      "UPDATE media_asset SET status = 'ready' WHERE id = $1 AND owner_user_id = $2 AND status = 'uploading' AND deleted_at IS NULL",
      [id, request.user!.id],
    );
    if (result.rowCount === 0)
      return sendFailure(
        reply,
        request,
        404,
        "permanent",
        "media.not_found",
        "Upload not found or already completed.",
      );
    try {
      await context.queue.enqueue("media.process", { mediaAssetId: id });
    } catch (error) {
      // Dispatch failure mid-pipeline: revert so the client can retry complete.
      request.log.error({ err: error }, "media.process dispatch failed");
      await context.pool!.query(
        "UPDATE media_asset SET status = 'uploading' WHERE id = $1 AND status = 'ready'",
        [id],
      );
      return sendFailure(
        reply,
        request,
        503,
        "retryable",
        "media.dispatch_failed",
        "Could not queue media processing. Retry completing the upload.",
      );
    }
    return {
      mediaAsset: await one(
        context.pool!,
        "SELECT id, kind, status, content_type, size_bytes FROM media_asset WHERE id = $1",
        [id],
      ),
    };
  });

  app.get("/v1/media/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const asset = await one<{ object_key: string; status: string }>(
      context.pool!,
      "SELECT object_key, status FROM media_asset WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL",
      [id, request.user!.id],
    );
    if (!asset)
      return sendFailure(reply, request, 404, "permanent", "media.not_found", "Media not found.");
    if (asset.status !== "ready")
      return sendFailure(
        reply,
        request,
        409,
        "retryable",
        "media.not_ready",
        `Media status is ${asset.status}.`,
      );
    if (!context.objectStore)
      return sendFailure(
        reply,
        request,
        503,
        "retryable",
        "media.storage_unconfigured",
        "Object storage not configured.",
      );
    const signedUrl = await context.objectStore.presignDownload(asset.object_key, 300);
    return {
      asset: { id, status: asset.status },
      signedUrl,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  });

  app.delete("/v1/media/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await context.pool!.query(
      "UPDATE media_asset SET status = 'deleted', deleted_at = now() WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL",
      [id, request.user!.id],
    );
    if (result.rowCount === 0)
      return sendFailure(reply, request, 404, "permanent", "media.not_found", "Media not found.");
    try {
      await context.queue.enqueue("media.purge", { mediaAssetId: id });
    } catch (error) {
      // Deletion is already recorded (deleted_at set); the worker's deleted-media
      // sweep guarantees the object is still purged even without this job.
      request.log.error({ err: error }, "media.purge dispatch failed; sweep will purge");
    }
    await audit(context.pool!, {
      actorUserId: request.user!.id,
      action: "media.delete_requested",
      targetKind: "media_asset",
      targetId: id,
      requestId: request.id,
    });
    return reply.status(204).send();
  });
}
