-- 0009: remove all pre-production fixture-derived product data.
-- Test fixtures remain isolated in test packages; product tables contain only
-- inference produced by real providers.

UPDATE session_summary
SET best_shot_id = NULL
WHERE best_shot_id IN (SELECT id FROM shot WHERE source <> 'real');

UPDATE weekly_report
SET best_shot_id = NULL
WHERE best_shot_id IN (SELECT id FROM shot WHERE source <> 'real');

DELETE FROM ml_dataset_item
WHERE source_shot_id IN (SELECT id FROM shot WHERE source <> 'real');

DELETE FROM shot WHERE source <> 'real';

-- These tables are derived and can be rebuilt without losing source evidence.
-- Clear old mixed-source aggregates, then rebuild daily real-score rollups.
DELETE FROM progress_daily;

INSERT INTO progress_daily (
  user_id,
  day,
  shot_type_id,
  checkpoint_id,
  scoring_model_id,
  shot_count,
  avg_score,
  median_score,
  best_score
)
SELECT
  user_id,
  captured_at::date,
  shot_type_id,
  NULL,
  scoring_model_id,
  count(*)::int,
  avg(overall_score * 10),
  percentile_cont(0.5) WITHIN GROUP (ORDER BY overall_score * 10),
  max(overall_score * 10)
FROM shot
WHERE source = 'real'
  AND result_kind = 'scored'
  AND overall_score IS NOT NULL
  AND scoring_model_id IS NOT NULL
GROUP BY user_id, captured_at::date, shot_type_id, scoring_model_id;

UPDATE practice_session ps
SET shot_count = real_counts.shot_count,
    avg_score = real_counts.avg_score
FROM (
  SELECT
    ps2.id,
    count(s.id)::int AS shot_count,
    avg(s.overall_score) FILTER (WHERE s.result_kind = 'scored') AS avg_score
  FROM practice_session ps2
  LEFT JOIN shot s ON s.session_id = ps2.id AND s.source = 'real'
  GROUP BY ps2.id
) AS real_counts
WHERE ps.id = real_counts.id;

UPDATE drill SET active = false WHERE is_dev_fixture = true;
