-- Deletion tasks are retried after transient failures (storage outage, DB
-- hiccup) instead of stalling the account-deletion workflow forever. Attempts
-- are counted so a permanently failing task stays visibly 'failed' after the
-- cap rather than looping.
ALTER TABLE deletion_task ADD COLUMN attempts integer NOT NULL DEFAULT 0;

-- The worker also scans retryable failed tasks.
DROP INDEX idx_deletion_task_status;
CREATE INDEX idx_deletion_task_status
  ON deletion_task(status)
  WHERE status IN ('queued','processing','failed');
