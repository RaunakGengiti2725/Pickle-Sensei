# Free-rating identity ledger — mutation matrix

run_id: race-seed7 seed: 7 commit: 4d812e1aa699014cc0521fd92fde66908043aaa8
started: 2026-09-04T06:42:25.658Z finished: 2026-09-04T06:42:54.832Z

SQL mutants: 2 — KILLED 0, SURVIVED 2, HARNESS_ERROR 0
survivors caught only by the new probes: 2
survivors flagged equivalent by the author: 0
TS mutants: 0 — KILLED 0, SURVIVED 0, HARNESS_ERROR 0
survivors caught only by the new edge test: 0

## SQL mutants (existing suites: migrate / security_regression.sql / be-edge live / static pins)

| id                           | target      | verdict     | killed by (existing) | first failure | new probes that catch it | prior       |
| ---------------------------- | ----------- | ----------- | -------------------- | ------------- | ------------------------ | ----------- |
| S00_baseline                 | baseline    | BASELINE_OK |                      |               |                          | pass        |
| S36_reserve_no_advisory_lock | concurrency | SURVIVED    |                      |               | P1_reserve_race_two_keys | survive_gap |
| S45_apply_no_advisory_lock   | concurrency | SURVIVED    |                      |               | P2_sync_race_two_permits | survive_gap |

## TS mutants (existing edge black-box suite; the new free_rating_access_payload.test.ts is reported separately)

| id  | target | verdict | existing failures | new-test failures | prior |
| --- | ------ | ------- | ----------------- | ----------------- | ----- |

## Descriptions

- **S00_baseline** (baseline/baseline): unmodified migration chain (control)
- **S36_reserve_no_advisory_lock** (sql/concurrency): reserve_analysis_permit() drops the per-user advisory lock (concurrent different-key reserves both pass) — diff: /home/ubuntu/repos/Pickle-Sensei/artifacts/mutation/free-rating-ledger/race-seed7/mutants/S36_reserve_no_advisory_lock.diff
- **S45_apply_no_advisory_lock** (sql/concurrency): apply_synced_shot() drops the per-user advisory lock (two concurrent syncs with different permits both pass the backstop) — diff: /home/ubuntu/repos/Pickle-Sensei/artifacts/mutation/free-rating-ledger/race-seed7/mutants/S45_apply_no_advisory_lock.diff
