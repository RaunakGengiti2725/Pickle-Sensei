# xc-i18n — Unicode names / free text / size-cap harnesses

Adversarial, seeded, replayable harnesses for the cross-cutting i18n surface:
`sanitizeUserText`, edge-route validation, mobile client caps, SQLite local
persistence and Postgres text semantics. New files only; nothing here changes
production code, existing tests, migrations, tolerances or datasets.

Every artifact records the seed, the iteration counter, the exact JSON input,
its code points and its measurement in all four units (UTF-16 units, code
points, graphemes via `Intl.Segmenter`, UTF-8 bytes) so any counterexample can
be replayed with the commands below.

| Plane                                               | File                                                                          | Command                                                                                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Edge (Deno) sanitizer property suite                | `supabase/functions/api/__wf__/xc_i18n_sanitize_property_test.ts`             | `cd supabase/functions/api/__wf__ && XC_I18N_OUT=/tmp/xc/deno deno test -A --no-check --config deno.json xc_i18n_sanitize_property_test.ts` |
| Edge (Deno) real-handler route matrix               | `supabase/functions/api/__wf__/xc_i18n_routes_test.ts`                        | `cd supabase/functions/api/__wf__ && XC_I18N_OUT=/tmp/xc/deno deno test -A --no-check --config deno.json xc_i18n_routes_test.ts`            |
| Shared corpus / generators                          | `supabase/functions/api/__wf__/xc_i18n_unicode_corpus.ts`                     | (library)                                                                                                                                   |
| Mobile (Jest) client caps + KV persistence          | `apps/mobile/__tests__/xcI18nUnicodeNamesText.test.ts`                        | `cd apps/mobile && XC_I18N_OUT=/tmp/xc/mobile npx jest --ci __tests__/xcI18nUnicodeNamesText.test.ts`                                       |
| SQLite (real engine, app migrations)                | `scripts/xc-i18n/sqlite_unicode_roundtrip.mjs`                                | `XC_I18N_OUT=/tmp/xc/sqlite node --experimental-sqlite scripts/xc-i18n/sqlite_unicode_roundtrip.mjs`                                        |
| Postgres (disposable postgres:16 + every migration) | `supabase/tests/xc_i18n_unicode_probe.sql`, `scripts/xc-i18n/run_pg_probe.sh` | `scripts/xc-i18n/run_pg_probe.sh /tmp/xc/pg`                                                                                                |

Knobs: `XC_I18N_SEED` (default `20260904`), `XC_I18N_ITERS` (Deno sanitizer
properties default `20000`; route properties `2000`/`500`; mobile `5000`),
`XC_I18N_OUT` (artifact directory; artifacts are skipped when unset so the
suites also run inside `deno task test` / `npx jest --ci --silent`).

The Deno route matrix runs the real `supabase/functions/api/index.ts` handler
through `routesHarness.ts` (stubbed Supabase Auth/PostgREST). In that harness a
`503` on `PUT /v1/me/onboarding` means validation PASSED and the PATCH reached
the stub (which has no profile row for the fresh user); `400` means the route's
own validation rejected the value. The stored value is read from the PATCH body.

Linux evidence only: nothing here proves iOS `UITextInput` `maxLength`
semantics, the native op-sqlite binding, or any Apple runtime behaviour.
