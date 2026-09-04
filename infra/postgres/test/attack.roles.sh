#!/usr/bin/env bash
# Adversarial pass (shared-packages-ops #1, pass 3) — infra/postgres roles.
#
# Attacks the least-privilege login roles bootstrapped by init-roles.sql
# (pickle_app / pickle_worker / pickle_ro) against a database that has
# init-roles.sql applied AND every packages/database migration applied
# (0018_consent_role_separation.sql carries the grants).
#
# Usage:
#   PSQL="docker exec -i <container> psql" DBNAME=pickle_dev bash infra/postgres/test/attack.roles.sh
#   # or, with a local psql and a superuser URL whose host serves the roles:
#   PGHOST=localhost PGPORT=55432 DBNAME=pickle_dev bash infra/postgres/test/attack.roles.sh
#
# Exit 0 = every HELD assertion held and every OBSERVED pin still matches.
# Exit 1 = a HELD assertion broke or an OBSERVED pin changed (re-read it).
set -u
PSQL="${PSQL:-psql}"
DBNAME="${DBNAME:-pickle_dev}"
fail=0
pass=0

run() { # role sql -> first line of combined output
  local role="$1" sql="$2"
  $PSQL -U "$role" -d "$DBNAME" -At -v ON_ERROR_STOP=0 -c "$sql" 2>&1 | grep -v '^NOTICE:' | head -1
}
expect_match() { # label role sql regex
  local out
  out="$(run "$2" "$3")"
  if [[ "$out" =~ $4 ]]; then
    pass=$((pass + 1)); printf 'ok   %s\n' "$1"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n     sql: %s\n     got: %s\n     want: /%s/\n' "$1" "$3" "$out" "$4"
  fi
}

echo "== init-roles.sql idempotency (second application must be a no-op)"
if $PSQL -U pickle -d "$DBNAME" -v ON_ERROR_STOP=1 -q <"$(dirname "$0")/../init-roles.sql" >/dev/null 2>&1; then
  pass=$((pass + 1)); echo "ok   HELD: init-roles.sql applies twice without error"
else
  fail=$((fail + 1)); echo "FAIL HELD: init-roles.sql second application errored"
fi

echo "== role attributes"
expect_match "HELD: no pickle_* login role is SUPERUSER/CREATEROLE/CREATEDB/BYPASSRLS" pickle \
  "select count(*) from pg_roles where rolname in ('pickle_app','pickle_worker','pickle_ro','pickle_migrator') and (rolsuper or rolcreaterole or rolcreatedb or rolbypassrls)" '^0$'
expect_match "HELD: runtime roles have no CREATE on the database (no trusted-extension install)" pickle \
  "select bool_or(has_database_privilege(r,'$DBNAME','CREATE')) from unnest(array['pickle_app','pickle_worker','pickle_ro']) r" '^f$'
expect_match "HELD: runtime roles have no CREATE on schema public" pickle \
  "select bool_or(has_schema_privilege(r,'public','CREATE')) from unnest(array['pickle_app','pickle_worker','pickle_ro']) r" '^f$'

for role in pickle_app pickle_worker pickle_ro; do
  echo "== denied paths as $role"
  expect_match "HELD[$role]: UPDATE consent_record denied" "$role" "update consent_record set action='granted'" 'permission denied for table consent_record'
  expect_match "HELD[$role]: DELETE consent_record denied" "$role" "delete from consent_record" 'permission denied for table consent_record'
  expect_match "HELD[$role]: TRUNCATE consent_record denied" "$role" "truncate consent_record" 'permission denied for table consent_record'
  expect_match "HELD[$role]: DELETE consent_subject denied" "$role" "delete from consent_subject" 'permission denied for table consent_subject'
  expect_match "HELD[$role]: INSERT consent_subject_erasure denied" "$role" "insert into consent_subject_erasure default values" 'permission denied for table consent_subject_erasure'
  expect_match "HELD[$role]: INSERT schema_migrations denied" "$role" "insert into schema_migrations default values" 'permission denied for table schema_migrations'
  expect_match "HELD[$role]: DDL on consent_record denied" "$role" "alter table consent_record add column x int" 'must be owner of table'
  expect_match "HELD[$role]: CREATE TABLE in public denied" "$role" "create table public.evil(x int)" 'permission denied for schema public'
  expect_match "HELD[$role]: SET ROLE pickle_migration_owner denied" "$role" "set role pickle_migration_owner" 'permission denied to set role'
  expect_match "HELD[$role]: SET ROLE superuser denied" "$role" "set role pickle" 'permission denied to set role'
  expect_match "HELD[$role]: COPY TO file denied" "$role" "copy consent_record to '/tmp/x'" 'permission denied to COPY to a file'
  expect_match "HELD[$role]: pg_read_file denied" "$role" "select pg_read_file('/etc/hostname')" 'permission denied for function pg_read_file'
  expect_match "HELD[$role]: lo_import denied" "$role" "select lo_import('/etc/hostname')" 'permission denied for function lo_import'
  expect_match "HELD[$role]: untrusted/trusted extension install denied" "$role" "create extension if not exists pg_trgm" 'permission denied to create extension'
  expect_match "HELD[$role]: self-escalation denied" "$role" "alter role $role superuser" 'permission denied to alter role'
  expect_match "HELD[$role]: identity sequence setval denied" "$role" "select setval(pg_get_serial_sequence('consent_record','seq'), 1, false)" 'permission denied for sequence'
done

echo "== read-only role"
expect_match "HELD[pickle_ro]: INSERT hard_case_event denied" pickle_ro "insert into hard_case_event default values" 'permission denied for table hard_case_event'
expect_match "HELD[pickle_ro]: UPDATE user_consent denied" pickle_ro "update user_consent set granted=true" 'permission denied for table user_consent'
expect_match "HELD[pickle_ro]: SELECT on 0019_* tables (created after 0018) works via default privileges" pickle_ro "select count(*) from training_eligibility_ledger" '^[0-9]+$'

echo "== consent_record append path as pickle_app (OBSERVED pins)"
uid="$(run pickle_app "insert into app_user(auth_subject) values ('SYNTHETIC-TEST-FIXTURE.attack-roles-'||clock_timestamp()::text) returning id")"
ps="$(run pickle_app "insert into consent_subject(user_id) values ('$uid') returning pseudonym")"
ins="insert into consent_record(subject_pseudonym,scope,action,consent_version,source)"
expect_match "HELD: app can append a grant" pickle_app "$ins values ('$ps','model_training','granted','model-training-v1','mobile_settings') returning seq" '^[0-9]+$'
expect_match "HELD: app can append a withdrawal" pickle_app "$ins values ('$ps','model_training','withdrawn','model-training-v1','mobile_settings') returning seq" '^[0-9]+$'
expect_match "HELD: explicit seq WITHOUT OVERRIDING is rejected (GENERATED ALWAYS)" pickle_app \
  "insert into consent_record(seq,subject_pseudonym,scope,action,consent_version,source) values (5,'$ps','model_training','granted','model-training-v1','mobile_settings')" 'cannot insert a non-DEFAULT value into column "seq"'
forged="$(run pickle_app "select max(seq)+1000000 from consent_record")"
expect_match "OBSERVED: app CAN forge seq with OVERRIDING SYSTEM VALUE — a grant with seq=max+1e6 now outranks the withdrawal in ledger order (and will collide with the identity sequence later)" pickle_app \
  "insert into consent_record(seq,subject_pseudonym,scope,action,consent_version,source) overriding system value values ($forged,'$ps','model_training','granted','model-training-v1','mobile_settings') returning seq" "^${forged}\$"
expect_match "OBSERVED: latest-by-seq for the subject is now the forged GRANT" pickle_app \
  "select action from consent_record where subject_pseudonym='$ps' and scope='model_training' order by seq desc limit 1" '^granted$'
expect_match "OBSERVED: recorded_at in the far future (2099) is accepted — no CHECK" pickle_app \
  "insert into consent_record(subject_pseudonym,scope,action,consent_version,source,recorded_at) values ('$ps','model_training','granted','model-training-v1','mobile_settings','2099-01-01') returning recorded_at::date" '^2099-01-01$'
expect_match "OBSERVED: consent_version has no format CHECK — free text accepted" pickle_app \
  "$ins values ('$ps','model_training','granted','totally-free-text','mobile_settings') returning consent_version" '^totally-free-text$'
expect_match "OBSERVED: empty consent_version accepted" pickle_app \
  "$ins values ('$ps','model_training','granted','','mobile_settings') returning length(consent_version)" '^0$'

echo
echo "passed=$pass failed=$fail"
[[ $fail -eq 0 ]]
