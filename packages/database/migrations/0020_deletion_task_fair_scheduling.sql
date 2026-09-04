-- Round-robin deletion-task scheduling: the worker stamps every row it claims
-- and selects never-attempted / least-recently-attempted rows first, so
-- held-back rows cannot occupy the whole selection window every cycle.
ALTER TABLE deletion_task ADD COLUMN last_attempt_at timestamptz;
