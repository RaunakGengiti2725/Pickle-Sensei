# W01-03 adversarial evidence — candidate `ac7b495661d8c3b5f2cff6923457dd4857937cd9`

All runs against the candidate checkout (branch `devin/pp/w01-03/impl-r1`, HEAD = attacked_sha
above) with disposable PostgreSQL only (`postgres:16` containers on 127.0.0.1; production
untouched). Labels: VERIFIED = run here, log path given.

## Attack files

- `supabase/functions/api/__wf__/attack_w01_03_settlement.test.ts` — 15 Deno tests (edge
  handler through `routesHarness.ts` + live-PG RPC tests through `XC_PG_URL`).
- `supabase/tests/attack_w01_03/run_cascade_order_attack.sh` (+ `fixture_settled_shot.sql`,
  `cascade_order_attack.sql`) — SQL attack on account deletion vs the receipt lifecycle guard.

## Attack suite on the candidate (VERIFIED)

```
cd supabase/functions/api/__wf__ && XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
  deno test -A --no-check --config deno.json attack_w01_03_settlement.test.ts
```

exit 1 — `FAILED | 13 passed | 2 failed`, ignored 0 → `logs/attack_on_head_ac7b4956.log`.
The 2 failures are confirmed breaks (below); the 13 passes are attacks that did not break
the candidate.

## Cascade-order attack (VERIFIED)

```
./supabase/tests/attack_w01_03/run_cascade_order_attack.sh                       # attack
ATTACK_BURN_OIDS=0 ATTACK_LOG=supabase/tests/attack_w01_03/cascade_order_control.log \
  ./supabase/tests/attack_w01_03/run_cascade_order_attack.sh                     # control
```

attack: psql exit 3, `ATTACK CONFIRMED: account deletion ... raised 23514
(settlement_receipts: a receipt outlives every path but the shot cascade)` →
`cascade_order_attack.log`. control (same schema/data, oid counter not advanced): exit 0,
deletion cascades shot + receipt → `cascade_order_control.log`.

## Candidate acceptance re-run (VERIFIED)

- AC1 `npx --yes deno@2.5.6 check --node-modules-dir=none --frozen --lock=deno.lock supabase/functions/api/index.ts`
  → exit 0, `logs/ac1_check.log`.
- AC2 `cd supabase/functions/api/__wf__ && XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres deno task test`
  with the attack file present → exit 1, `FAILED | 819 passed (31 steps) | 2 failed`,
  ignored 0 (821 = candidate's 806 + 15 attack tests; the only 2 failures are the attack
  tests) → `logs/ac2_edge_full_with_attacks.log` (per-test result lines; full log uploaded
  as an attachment).
- AC3 `./supabase/tests/run_rls_tests.sh` → exit 0, 4 histories (fresh, production_20260906,
  upstream_20260906, ordered_20260907) × 3 matrices = 12 × `ALL CASES PASSED`
  → `logs/ac3_rls.log`.
- AC4-style regression of the attack file on BASE `d8e5db3eb346b651e4ce04cc997178abcbed56fe`
  (worktree + base-schema PG on :55434, only the attack file copied):
  exit 1, `FAILED | 1 passed | 14 failed` → `logs/ac4_attack_on_base.log`
  (the 1 pass is the RPC-transport-5xx attack, pre-existing behaviour). On HEAD: 13/15.

## Confirmed breaks

1. P0 — account deletion fails for any user with one settled shot once the
   `settlement_receipts`→`profiles` RI cascade fires before `shots`→`profiles`. PostgreSQL
   fires same-event RI triggers in trigger-NAME order (`RI_ConstraintTrigger_a_<oid>`, text
   sort); the candidate's `settlement_receipts_guard_lifecycle` raises 23514 when the shot
   still exists. Whether production is in that state depends on its oid counter (UNKNOWN);
   the attack proves the schema's correctness depends on it.
2. P2 — `apply_synced_shot` under-lock replay treats an identical binding under a rotated
   policy lineage as `shot.receipt_mismatch` (a permanent-class client verdict, "settled with
   different details") while the edge's own replay check (`index.ts` binding-only compare)
   and the RPC's `unique_violation` branch both call the same retry identical. Reached when
   two identical retries race to the RPC across a rotation. Self-heals on the next drain via
   the edge's stored-receipt path; no second charge.
3. P3 — the same shot id twice in one `POST /v1/sync/shots` batch is answered with the id
   twice in `acceptedIds` (and two receipts); the mobile decoder
   (`apps/mobile/src/data/api.ts` `parseShotSyncAcknowledgement`) rejects such a body as
   invalid. The shipping outbox dedupes by shot id, so only a malformed client reaches it;
   one charge either way.
