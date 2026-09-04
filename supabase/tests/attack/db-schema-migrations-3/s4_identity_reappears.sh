#!/usr/bin/env bash
# S4 — the same Google subject reappears under a NEW auth.identities.id
# (identical provider_id/provider, different identity row id, different
# email/name, different user id). free_rating_identity_hash must be stable
# and all three decision points must honour the ledger.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
DB=s4
fresh_db $DB
A=11111111-1111-1111-1111-111111111111
A2=aaaaaaaa-2222-2222-2222-222222222222
A3=aaaaaaaa-3333-3333-3333-333333333333
SUB='105123456789012345678'   # realistic Google sub

as() { # as <uid> <sql>
  dpsql $DB -Atq <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$1', true);
$2;
commit;
SQL
}
ledger() { dq $DB "select coalesce((select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google','$SUB')), -1)"; }

dq $DB "select attack.mk_user('$A', 'alice@gmail.test', 'google', '$SUB', '99999999-0000-0000-0000-000000000001')" >/dev/null
H1=$(dq $DB "select public.free_rating_identity_hash(i.provider, i.provider_id) from auth.identities i where i.user_id='$A'")

# Spend both free ratings through the real path.
for i in 1 2; do
  as $A "select result from public.reserve_analysis_permit('k$i')" >/dev/null
  P=$(dq $DB "select id from public.analysis_permits where user_id='$A' and idempotency_key='k$i'")
  as $A "select public.apply_synced_shot(attack.shot_json(gen_random_uuid(), '$P', 'scored', 7))" | tail -1
done
assert_eq "ledger after two scored shots" "$(ledger)" "2"
assert_eq "alice access_state" "$(as $A "select scored_count from public.access_state()" | tail -1)" "2"

# Account deleted (auth.users cascade → profiles → shots/permits gone).
dq $DB "delete from auth.users where id='$A'" >/dev/null
assert_eq "shots cascaded away" "$(dq $DB "select count(*) from public.shots")" "0"
assert_eq "ledger survives account deletion" "$(ledger)" "2"

# Reappearance: new auth user, NEW identities.id, same provider_id, different
# email + unicode display name.
dq $DB "select attack.mk_user('$A2', 'alice.renamed@gmail.test', 'google', '$SUB', '99999999-0000-0000-0000-000000000002')" >/dev/null
dq $DB "update auth.identities set identity_data = identity_data || '{\"name\":\"Ålice Ünïcödé 🥒\"}' where user_id='$A2'" >/dev/null
H2=$(dq $DB "select public.free_rating_identity_hash(i.provider, i.provider_id) from auth.identities i where i.user_id='$A2'")
assert_eq "identity hash stable across identities.id change" "$H2" "$H1"
assert_eq "identity row id actually changed" "$(dq $DB "select id from auth.identities where user_id='$A2'")" "99999999-0000-0000-0000-000000000002"

assert_eq "access_state(new account) honours ledger" \
  "$(as $A2 "select premium || '|' || scored_count || '|' || reserved_count from public.access_state()" | tail -1)" "false|2|0"
assert_eq "reserve refused for new account" \
  "$(as $A2 "select result from public.reserve_analysis_permit('k-new')" | tail -1)" "access.paywall_required"

# Forge a reserved permit directly (authenticated can INSERT own permits) and
# try to sync a scored shot with it — the apply backstop must refuse.
FP=cccccccc-0000-0000-0000-000000000001
as $A2 "insert into public.analysis_permits (id, user_id, idempotency_key) values ('$FP', '$A2', 'forged')" >/dev/null
assert_eq "apply_synced_shot with forged permit refused" \
  "$(as $A2 "select public.apply_synced_shot(attack.shot_json('dddddddd-0000-0000-0000-000000000001', '$FP', 'scored', 9))" | tail -1)" "access.paywall_required"
assert_eq "forged permit released/free_limit_exceeded" \
  "$(dq $DB "select status || '/' || outcome from public.analysis_permits where id='$FP'")" "released/free_limit_exceeded"
assert_eq "no scored shot written" "$(dq $DB "select count(*) from public.shots where user_id='$A2'")" "0"

# Abstentions are still allowed (low_confidence never touches the ledger).
FP2=cccccccc-0000-0000-0000-000000000002
as $A2 "insert into public.analysis_permits (id, user_id, idempotency_key) values ('$FP2', '$A2', 'forged2')" >/dev/null
assert_eq "low_confidence sync still accepted" \
  "$(as $A2 "select public.apply_synced_shot(attack.shot_json('dddddddd-0000-0000-0000-000000000002', '$FP2', 'low_confidence'))" | tail -1)" "accepted"
assert_eq "ledger untouched by abstention" "$(ledger)" "2"

# ---- S4b: identity relinked under the SAME user (unlink → relink gives a
# new identities.id without deleting the account).
dq $DB "delete from auth.identities where user_id='$A2'" >/dev/null
assert_eq "no identity → identity_scored_count falls back to own shots (0)" \
  "$(as $A2 "select scored_count from public.access_state()" | tail -1)" "0"
dq $DB "insert into auth.identities (id, provider_id, user_id, identity_data, provider) values ('99999999-0000-0000-0000-000000000003', '$SUB', '$A2', '{\"email\":\"x@y.test\"}', 'google')" >/dev/null
assert_eq "relinked identity → ledger honoured again" \
  "$(as $A2 "select scored_count from public.access_state()" | tail -1)" "2"

# ---- S4c: hash sensitivity — different provider or case changes the key
# (documented limit: Apple-then-Google is a different identity).
assert_eq "same sub under provider 'apple' is a different identity" \
  "$(dq $DB "select public.free_rating_identity_hash('apple','$SUB') = '$H1'")" "f"
assert_eq "hash is sha256(provider:provider_id) lowercase hex" \
  "$(dq $DB "select public.free_rating_identity_hash('google','$SUB') = encode(sha256(convert_to('google:$SUB','UTF8')),'hex')")" "t"
echo "S4c INFO | hash('a','b:c') = hash('a:b','c'): $(dq $DB "select public.free_rating_identity_hash('a','b:c') = public.free_rating_identity_hash('a:b','c')") (delimiter-ambiguous; harmless while provider ∈ {apple,google} and neither contains ':')"

# ---- S4d: two DIFFERENT users concurrently holding the same provider identity
# is blocked by the shim's unique(provider_id, provider) — as in hosted Supabase.
dup_rc=0
dq $DB "select attack.mk_user('$A3', 'imposter@x.test', 'google', '$SUB')" >/dev/null 2>&1 || dup_rc=$?
assert_eq "duplicate (provider_id, provider) rejected" "$([ $dup_rc -ne 0 ] && echo rejected || echo allowed)" "rejected"

finish_scenario s4_identity_reappears
