# DB stress harness — `apply_synced_shot(jsonb)` boundary / malformed input

Seeded, replayable fuzz campaign against the synced-shot write path
(`public.apply_synced_shot(jsonb)`, `enforce_scored_shot_permit()`,
`shots` / `shot_phases` / `shot_checkpoints` / `shot_measurements`,
`analysis_permits`, `free_rating_ledger`). Runs only against a disposable
Postgres — never the hosted project.

## Files

| file                                           | role                                                                                                                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stress_pg_up.sh`                              | wraps `supabase/functions/api/__wf__/xc_pg_up.sh`: `postgres:16` on port 5499, `shim_auth.sql` + every migration in order. `./stress_pg_up.sh down` tears it down.                     |
| `boundary_malformed_gen.ts`                    | pure seeded generator (FNV-1a seed per iteration → xorshift PRNG). No I/O, no DB. `generate(iterSeed, fixture)` is deterministic.                                                      |
| `boundary_malformed_apply_synced_shot.test.ts` | Deno runner: fixture users, one transaction per iteration (rolled back), cast probe → RPC call → owner-eye post-state checks, flake re-runs, greedy seed minimisation, JSON artifacts. |
| `repro_apply_synced_shot_uuid_cast_raise.sql`  | minimised psql repro of the one BROKEN behaviour found (uuid casts raise out of the function with the client value echoed).                                                            |
| `deno.json`                                    | pins `postgres@3.4.5` (same as `__wf__`).                                                                                                                                              |

## Run

```bash
eval "$(./supabase/tests/stress/stress_pg_up.sh)"        # prints STRESS_PG_URL=...
cd supabase/tests/stress
deno test -A --no-check --config deno.json boundary_malformed_apply_synced_shot.test.ts        # 150 iterations (~1s)
STRESS_ITER=3000 STRESS_OUT_DIR=/tmp/stress-3000 deno test -A --no-check --config deno.json boundary_malformed_apply_synced_shot.test.ts
```

| env                              | default                | meaning                                                                                          |
| -------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `STRESS_PG_URL` (or `XC_PG_URL`) | —                      | disposable DB; test fails fast if unset                                                          |
| `STRESS_ITER`                    | `150`                  | iterations; full campaign is `3000`                                                              |
| `STRESS_SEED`                    | `20260904`             | campaign seed; iteration seed = `fnv1a("<seed>:<i>")`                                            |
| `STRESS_LANES`                   | `8`                    | parallel connections (each iteration is its own transaction)                                     |
| `STRESS_REPEAT`                  | `10`                   | re-runs per failing seed (flake rate)                                                            |
| `STRESS_SLOW_MS`                 | `5000`                 | per-call latency ceiling                                                                         |
| `STRESS_OUT_DIR`                 | `/tmp/stress-boundary` | artifacts: `results.json` (seed → outcome table), `summary.json`, `failing.json`, `fixture.json` |

Replay one seed: set `STRESS_ITER=1 STRESS_SEED=<seed>` is NOT how seeds
work — the iteration seed is what is reported. To replay a reported seed,
`import { generate } from "./boundary_malformed_gen.ts"` with the
`fixture.json` users and call `generate(<seed>, fixture)`; the runner's
`minimize()` and flake re-runs do exactly this.

## What is generated (per iteration, from the seed)

- caller: `authenticated` + `request.jwt.claim.sub` (4 users: two free,
  one premium, one already at the 2-rating lifetime limit), `authenticated`
  without `sub`, `anon`, `service_role`
- identifiers: fresh / owned replay / another user's row / malformed
  (traversal, `urn:uuid:`, `0x…`, braces, whitespace, nil, empty, …)
- permit: live / expired (>24h) / already finalized / another user's / random / nil / malformed
- text classes: well-formed object with 0–3 field mutations, raw JSON number
  tokens (`NaN`, `Infinity`, `-0`, `1e999`, `1e131073`, `007`, `.5`), raw
  escape strings (lone/paired surrogates, `\u0000`, over-long escapes),
  duplicate keys (first/last wins), truncated JSON, garbage (comments,
  single quotes, BOM, trailing NUL, NDJSON, python literals), non-object
  roots, 64 KB – 1 MB strings in every text column
- mutations: wrong types everywhere (top level, versionVector, phases,
  checkpoints), prototype-pollution keys (`__proto__`, `constructor`,
  `$where`, …), byte/codepoint/grapheme cap probes (ASCII, NFC/NFD, astral,
  ZWJ families, RTL, BOM, ZWSP) around the 64-char caps, path traversal in
  every string field, future `schemaVersion`, empty arrays/objects, nesting
  to depth 5000, 1000-element phase/checkpoint arrays, ms ordering / overflow /
  negative / fractional, scored ⇄ low_confidence coherence mismatches, numeric
  string vs literal, `-0`, `0.30000000000000004`, out-of-range enums.

## Invariants asserted per iteration

| violation                  | meaning                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RAISE_ESCAPED:<sqlstate>` | the RPC threw instead of returning a typed status (42501 tolerated for `anon`/`service_role`, which have no EXECUTE)                                     |
| `RAISE_MESSAGE_ECHO`       | the raised message quotes a value taken from the payload (detail leak on the wire)                                                                       |
| `RESULT_UNKNOWN`           | status string outside the documented set / `shot.write_failed:<SQLSTATE>`                                                                                |
| `WRITE_ON_REJECT`          | any row/ledger delta although the status was not `accepted` (or the call raised)                                                                         |
| `PERMIT_DRIFT`             | permit state changed on a path that must not touch it, or the consumed permit did not become `consumed`, or a spent permit was reused                    |
| `ROW_UNSANE`               | accepted row is not owned by the caller, breaks scored/low_confidence coherence, ranges, caps, detail-row ownership, ledger delta, or the lifetime limit |
| `CAST_UNEXPECTED_STATE`    | `::jsonb` cast failed with a SQLSTATE outside the 22xxx/54001 data-exception family                                                                      |
| `SLOW`, `CONN_DEAD`        | latency ceiling / connection killed                                                                                                                      |

`summary.json` also lists _lenient accepts_: fresh rows the DB accepted
although a poison was applied (e.g. `contactMs` deleted → `contact_ms NULL`,
`shotType: "../../etc/passwd"`, `start_ms = -1`). These are review items,
not violations — the edge parser (`parseSyncShot`) rejects them before the
RPC — and are kept in the artifact so the defense-in-depth gap is visible.
