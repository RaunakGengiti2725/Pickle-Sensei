# Persisted-state fuzz harness (`apps/mobile`)

Deterministic, replayable fuzzing of every reader of durable mobile state:
SQLite `kv` values consumed by the Zustand stores, owner-scoped repository
rows (`local_shot`, `local_capture`, `local_session`, `local_analysis_record`,
`outbox`) and the Keychain session vault. The readers under test are the real
production modules; only the SQLite driver (`getDb`) and the Keychain native
module are replaced by the in-memory fakes this app's suites already use.

## Suites

| Suite                                       | Surfaces | Drives                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | -------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `__tests__/fuzzPersistedKv.fuzz.test.ts`    |       11 | `appStore.hydrate` (profile, pending stash, capture stats), consistency / notification / review / rank / practice / walkthrough / auth-local-mode stores                                                                                                                                                                                            |
| `__tests__/fuzzPersistedRows.fuzz.test.ts`  |       14 | `getAnalysis`, `listRealAnalysisFacts`, `listScoredCheckpointFacts`, `listAnalysisRecords`, `getCaptureTargetSeed`, `listPendingCaptures`/`listCaptureHistory`, `listLiveSessionHistory`, `drainOutbox` (4 row shapes), `loadStrokeResultEvidence`, the `FormReviewScreen` load-effect chain (`loadStrokeResultEvidence` → `buildFormReviewScript`) |
| `__tests__/fuzzPersistedVault.fuzz.test.ts` |        2 | `sessionVault.loadPersistedSession`, `authStore.hydrate` from the vault with a stubbed `/v1/auth/refresh`                                                                                                                                                                                                                                           |

Every surface runs all 15 generators in `support/generators.ts`: `valid`
(semantically equal re-serialisation: key order / whitespace / unicode
escapes), `random_bytes`, `random_ascii`, `truncated_json`, `byte_flip`,
`wrong_types`, `future_version`, `json_scalars`, `deep_nesting`,
`huge_string`, `proto_keys`, `unicode_noise`, `wrapped`, `empty_whitespace`
and `typed_value` (non-string SQLite column values a typed driver can return:
NULL, numbers, booleans, blobs, objects).

## Outcomes

- `accepted` — reader produced a well-formed value (required for `valid`).
- `rejected` — reader refused the input and landed in a safe default / empty /
  quarantined state.
- `lenient` — reader kept a structurally off value that callers tolerate;
  reported in the matrix, not a failure.
- `invariant` — reader "succeeded" but left state the user cannot recover from
  (a failure unless the surface pins it as `knownInvariant`).
- `threw` — an exception escaped the reader (always a failure).

A `knownInvariant` pin is deliberately narrow: it names the finding, the
`file:line`s and a `detail` regex. Only invariants whose detail matches the
regex are tolerated (and counted in `knownInvariants` of the report); any other
invariant on that surface still fails the suite, and the suite also fails if
the pinned finding stops reproducing — that is the signal to delete the pin
once production is fixed. Current pins:

| Surface                   | Finding                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appStore.profile`        | durable `profile` kv is `JSON.parse(raw) as Profile` with no shape check (`src/state/appStore.ts:182`); HomeScreen reads its fields directly                                                                                    |
| `authStore.hydrate.vault` | a vault record whose `canonicalAppUserId` is a non-empty non-UUID string passes `parsePersistedSession`, `canonicalDataOwner()` then throws inside `restorePersistedSession`, `hydrate()` signs out but never clears the record |

## Running

```bash
cd apps/mobile
FUZZ_CASES=200 FUZZ_RUN_ID=my-run npx jest --ci __tests__/fuzzPersisted
# one replay:
FUZZ_SEED=20260904 FUZZ_REPLAY='appStore.profile:wrong_types:17' \
  npx jest __tests__/fuzzPersistedKv.fuzz.test.ts
```

| Variable            | Default    | Meaning                                                 |
| ------------------- | ---------- | ------------------------------------------------------- |
| `FUZZ_CASES`        | `200`      | cases per generator per surface                         |
| `FUZZ_SEED`         | `20260904` | master seed; every case seed derives from it (FNV-1a)   |
| `FUZZ_RUN_ID`       | timestamp  | report directory name                                   |
| `FUZZ_OUT_DIR`      | —          | overrides `artifacts/fuzz-mobile-persisted-state/<id>/` |
| `FUZZ_REPLAY`       | —          | `<surface>:<generator>:<index>` — run exactly one case  |
| `FUZZ_ONLY_SURFACE` | —          | restrict a suite to one surface                         |

With `FUZZ_REPLAY` / `FUZZ_ONLY_SURFACE` set, the other surfaces of the suite
are reported as skipped rather than failed, and the "pinned finding no longer
reproduces" check is suspended for the replayed single case.

Reports: `<out>/kv.json`, `rows.json`, `vault.json` (per-surface counts,
generator × outcome matrix, heap samples, max case duration, every failure
with seed + serialized input) and matching `.md` matrices.
