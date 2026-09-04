#!/usr/bin/env bash
# Replay every profiles PATCH the fuzz campaign produced against a REAL
# Postgres 16 with every migration applied.
#
# The in-process campaign (stress_route_put_onboarding_fuzz.test.ts) stubs
# PostgREST, so it can only assert the SHAPE of the write. This script closes
# the loop: it boots a throwaway postgres:16, installs the Supabase shim
# (supabase/tests/shim_auth.sql), applies supabase/migrations in order, then
# replays each recorded patch as the exact UPDATE the edge function issues.
# Any value the route lets through that the schema refuses — profiles_text_bounds
# (skill_level ≤ 100, focus_checkpoint ≤ 100, primary_goal ≤ 200,
# biggest_problem ≤ 500), first_name ≤ 80, the gender / handedness /
# onboarding_state CHECKs — raises here, which in production is a 503.
# Every replayed row is also read back and compared to the value sent, so a
# silent truncation or encoding change would fail too.
#
#   supabase/functions/api/__wf__/stress_onboarding_pg_replay.sh \
#     [artifacts/stress-route-put-onboarding/latest/fuzz_seed_20260904_n3000.json ...]
#
# Exits non-zero on any refused or mangled write.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$REPO_ROOT"

ARTIFACTS=("$@")
if [ "${#ARTIFACTS[@]}" -eq 0 ]; then
  shopt -s nullglob
  ARTIFACTS=(artifacts/stress-route-put-onboarding/latest/fuzz_seed_*.json)
  shopt -u nullglob
fi
if [ "${#ARTIFACTS[@]}" -eq 0 ]; then
  echo "No campaign artifacts found; run stress_route_put_onboarding_fuzz.test.ts first." >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# One CSV row per recorded patch: the patch JSON in a single quoted field.
jq -r '.outcomes[] | select(.patchBody != null) | [(.patchBody | tojson)] | @csv' \
  "${ARTIFACTS[@]}" | sort -u > "$WORK/patches.csv"
PATCH_COUNT="$(wc -l < "$WORK/patches.csv" | tr -d ' ')"
echo "replaying $PATCH_COUNT distinct profiles patches from ${#ARTIFACTS[@]} artifact(s)"
if [ "$PATCH_COUNT" -eq 0 ]; then
  echo "artifacts contain no accepted writes to replay" >&2
  exit 2
fi

cat > "$WORK/replay.sql" <<'SQL'
\set ON_ERROR_STOP on
create temporary table stress_patches (doc jsonb);
\copy stress_patches (doc) from '/replay/patches.csv' with (format csv)

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values (
  '33333333-3333-4333-8333-333333333333',
  'stress@example.test',
  '{"full_name":"Stress Tester"}'::jsonb,
  '{"provider":"google"}'::jsonb
)
on conflict (id) do nothing;

-- handle_new_user() provisions the profile row on user insert; make the
-- script independent of that trigger firing.
insert into public.profiles (id, email, provider)
values ('33333333-3333-4333-8333-333333333333', 'stress@example.test', 'google')
on conflict (id) do nothing;

do $$
declare
  uid uuid := '33333333-3333-4333-8333-333333333333';
  r record;
  d jsonb;
  n integer := 0;
  stored record;
begin
  for r in select doc from stress_patches loop
    d := r.doc;
    -- The exact column set the edge route patches (index.ts
    -- "PUT /v1/me/onboarding"); absent optional keys keep their value, which
    -- is what PostgREST does with a partial patch body.
    update public.profiles set
      skill_level      = coalesce(d ->> 'skill_level', skill_level),
      handedness       = coalesce(d ->> 'handedness', handedness),
      primary_goal     = coalesce(d ->> 'primary_goal', primary_goal),
      biggest_problem  = coalesce(d ->> 'biggest_problem', biggest_problem),
      focus_checkpoint = coalesce(d ->> 'focus_checkpoint', focus_checkpoint),
      onboarding_state = coalesce(d ->> 'onboarding_state', onboarding_state),
      first_name       = coalesce(d ->> 'first_name', first_name),
      gender           = coalesce(d ->> 'gender', gender)
    where id = uid;

    if not found then
      raise exception 'patch % updated no row', d;
    end if;

    select skill_level, handedness, primary_goal, biggest_problem,
           focus_checkpoint, onboarding_state, first_name, gender
      into stored
      from public.profiles
     where id = uid;

    -- Read-back: what the route sent is byte-for-byte what the table holds.
    if (d ? 'skill_level' and stored.skill_level is distinct from d ->> 'skill_level')
       or (d ? 'handedness' and stored.handedness is distinct from d ->> 'handedness')
       or (d ? 'primary_goal' and stored.primary_goal is distinct from d ->> 'primary_goal')
       or (d ? 'biggest_problem'
           and stored.biggest_problem is distinct from d ->> 'biggest_problem')
       or (d ? 'focus_checkpoint'
           and stored.focus_checkpoint is distinct from d ->> 'focus_checkpoint')
       or (d ? 'onboarding_state'
           and stored.onboarding_state is distinct from d ->> 'onboarding_state')
       or (d ? 'first_name' and stored.first_name is distinct from d ->> 'first_name')
       or (d ? 'gender' and stored.gender is distinct from d ->> 'gender') then
      raise exception 'stored row does not match patch %', d;
    end if;

    n := n + 1;
  end loop;

  raise notice 'replayed % patches with no constraint violation', n;
end $$;

select onboarding_state, handedness, gender,
       length(skill_level) as skill_len,
       length(primary_goal) as goal_len,
       length(biggest_problem) as problem_len,
       length(first_name) as first_name_len
  from public.profiles
 where id = '33333333-3333-4333-8333-333333333333';
SQL

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required (postgres:16) for the database-backed replay." >&2
  exit 1
fi

CONTAINER=pickle-onboarding-stress-pg
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "postgres:16 container did not become ready within 60s" >&2
  docker logs "$CONTAINER" 2>&1 | tail -20 >&2
  exit 2
fi

docker cp supabase/tests "$CONTAINER":/tests >/dev/null
docker cp supabase/migrations "$CONTAINER":/migrations >/dev/null
docker exec "$CONTAINER" mkdir -p /replay
docker cp "$WORK/patches.csv" "$CONTAINER":/replay/patches.csv >/dev/null
docker cp "$WORK/replay.sql" "$CONTAINER":/replay/replay.sql >/dev/null

docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
  psql -U postgres -v ON_ERROR_STOP=1 -f /replay/replay.sql
'
echo "PASS: every recorded onboarding patch is accepted verbatim by the real schema"
