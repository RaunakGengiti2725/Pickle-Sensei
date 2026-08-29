import type { AppContext } from "../../context.js";
import { many } from "../../lib/db.js";
import {
  externalEmbedUrl,
  validateExternalVideoSource,
  type ExternalVideoProvider,
} from "./logic.js";

interface PublishedMediaRow extends Record<string, unknown> {
  id: string;
  media_asset_id: string | null;
  external_provider: ExternalVideoProvider | null;
  external_video_id: string | null;
  source_url: string;
  creator_name: string;
  license_name: string;
  license_url: string | null;
  attribution: string;
  object_key: string | null;
  asset_status: string | null;
  asset_kind: string | null;
}

export type InstructionalPlayback =
  | {
      id: string;
      kind: "hosted";
      playbackUrl: string;
      expiresAt: string;
      sourceUrl: string;
      creatorName: string;
      licenseName: string;
      licenseUrl: string | null;
      attribution: string;
    }
  | {
      id: string;
      kind: "embed";
      provider: ExternalVideoProvider;
      videoId: string;
      embedUrl: string;
      sourceUrl: string;
      creatorName: string;
      licenseName: string;
      licenseUrl: string | null;
      attribution: string;
    };

/**
 * Returns only media that has complete rights + coach review evidence. Invalid
 * direct DB rows and unavailable object storage are omitted, never represented
 * by a placeholder playback URL.
 */
export async function publishedInstructionalMedia(
  context: AppContext,
  drillId: string,
): Promise<InstructionalPlayback[]> {
  const rows = await many<PublishedMediaRow>(
    context.pool!,
    `SELECT dim.id, dim.media_asset_id, dim.external_provider, dim.external_video_id,
            dim.source_url, dim.creator_name, dim.license_name, dim.license_url,
            dim.attribution, ma.object_key, ma.status AS asset_status, ma.kind AS asset_kind
     FROM drill_instructional_media dim
     LEFT JOIN media_asset ma ON ma.id = dim.media_asset_id AND ma.deleted_at IS NULL
     WHERE dim.drill_id = $1
       AND dim.active
       AND dim.rights_status = 'approved'
       AND dim.coach_status = 'approved'
       AND dim.rights_reviewed_at IS NOT NULL
       AND dim.coach_reviewed_at IS NOT NULL
       AND (dim.rights_expires_at IS NULL OR dim.rights_expires_at > now())
       AND NULLIF(btrim(dim.creator_name), '') IS NOT NULL
       AND NULLIF(btrim(dim.license_name), '') IS NOT NULL
       AND NULLIF(btrim(dim.attribution), '') IS NOT NULL
       AND (
         (dim.media_asset_id IS NOT NULL AND ma.status = 'ready'
           AND ma.kind IN ('drill_video','reference_video'))
         OR
         (dim.external_provider IS NOT NULL AND dim.external_video_id IS NOT NULL
           AND dim.embed_approved_at IS NOT NULL)
       )
     ORDER BY dim.display_order, dim.created_at`,
    [drillId],
  );

  const items: InstructionalPlayback[] = [];
  for (const row of rows) {
    if (row.media_asset_id) {
      if (!context.objectStore || !row.object_key || row.asset_status !== "ready") continue;
      const expiresSeconds = 300;
      items.push({
        id: row.id,
        kind: "hosted",
        playbackUrl: await context.objectStore.presignDownload(row.object_key, expiresSeconds),
        expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString(),
        sourceUrl: row.source_url,
        creatorName: row.creator_name,
        licenseName: row.license_name,
        licenseUrl: row.license_url,
        attribution: row.attribution,
      });
      continue;
    }

    if (!row.external_provider || !row.external_video_id) continue;
    if (!validateExternalVideoSource(row.external_provider, row.source_url)) continue;
    const embedUrl = externalEmbedUrl(row.external_provider, row.external_video_id);
    if (!embedUrl) continue;
    items.push({
      id: row.id,
      kind: "embed",
      provider: row.external_provider,
      videoId: row.external_video_id,
      embedUrl,
      sourceUrl: row.source_url,
      creatorName: row.creator_name,
      licenseName: row.license_name,
      licenseUrl: row.license_url,
      attribution: row.attribution,
    });
  }
  return items;
}
