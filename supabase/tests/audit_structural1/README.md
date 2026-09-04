# Structural audit probes — `db-rls-grants-isolation` (pass 1)

Additive probes written against commit `4d812e1aa699014cc0521fd92fde66908043aaa8`.
Nothing here modifies `security_regression.sql`, `shim_auth.sql`,
`run_rls_tests.sh`, or any migration.

```bash
./supabase/tests/audit_structural1/run_probes.sh [--hosted-fn] [--out DIR]
```

- Throwaway Docker `postgres:16` (same recipe as `run_rls_tests.sh`): shim →
  (optional `hosted_function_defaults.sql`) → every migration → the existing
  security matrix → `probes.sql` → `concurrency.sh`.
- Exit 0 only when the existing matrix passes AND no probe line is `FAIL`.
- Output: `results.txt` (`RESULT|<id>|PASS|FAIL|INFO|<detail>`), `summary.txt`,
  `matrix.log`, `probes.raw.log`, `concurrency.raw.log`, `setup.log`.

`FAIL` lines are the intended-behaviour assertions that do NOT hold on the
target commit (see the audit report). `INFO` lines are observations recorded
for the coordinator that are not asserted either way.
