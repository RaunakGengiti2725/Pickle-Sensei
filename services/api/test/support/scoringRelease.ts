import type { Pool } from "pg";

/**
 * Test-only release evidence. Production releases must use the audited admin
 * endpoint with real immutable artifacts; integration tests need a known
 * active bundle in order to exercise successful score ingestion.
 */
export async function publishTestScoringRelease(
  pool: Pool,
  modelBundleVersion = "test-native-1",
): Promise<void> {
  const actor = await pool.query<{ id: string }>(
    `INSERT INTO app_user (auth_subject)
     VALUES ('test-only|scoring-release-actor')
     ON CONFLICT (auth_subject) DO UPDATE SET updated_at = now()
     RETURNING id`,
  );
  const bundle = await pool.query<{ id: string }>(
    `INSERT INTO model_bundle
       (version, manifest_sha256, status, rollout_percent, metadata)
     VALUES ($1, $2, 'active', 100, $3)
     ON CONFLICT (version) DO UPDATE SET
       manifest_sha256 = EXCLUDED.manifest_sha256,
       status = 'active', rollout_percent = 100, metadata = EXCLUDED.metadata
     RETURNING id`,
    [
      modelBundleVersion,
      "a".repeat(64),
      JSON.stringify({ testOnly: true, neverProductionEvidence: true }),
    ],
  );
  await pool.query(
    `UPDATE scoring_model SET
       model_bundle_id = $1, status = 'active',
       dataset_snapshot_id = 'test-only-dataset-snapshot',
       evaluation_report_sha256 = $2,
       coach_validation_reference = 'test-only-coach-review',
       released_by = $3, released_at = now(), active_from = now(), active_to = NULL`,
    [bundle.rows[0]!.id, "b".repeat(64), actor.rows[0]!.id],
  );
}
