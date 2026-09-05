# Disposable postgres:16 with pg_cron preloaded, so the stress harnesses under
# supabase/tests/stress/ can read the three maintenance jobs from cron.job
# instead of falling back to the migration literals (stock postgres:16 has no
# pg_cron and 20260831000000_scale_and_security.sql skips the schedules).
#
#   docker build -t pickle-pg16-cron -f supabase/tests/stress/pgcron.Dockerfile .
#   docker run -d --name pickle-stress-pgcron -p 127.0.0.1:5498:5432 \
#     -e POSTGRES_PASSWORD=pg pickle-pg16-cron
#   docker cp supabase/tests pickle-stress-pgcron:/tests
#   docker cp supabase/migrations pickle-stress-pgcron:/migrations
#   docker exec pickle-stress-pgcron bash -c 'psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql; \
#     for f in /migrations/*.sql; do psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"; done'
#   docker exec pickle-stress-pgcron psql -U postgres -c 'select jobname, schedule, command from cron.job'
#
# Disposable data only — never point this at the production project.
FROM postgres:16
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-16-cron && rm -rf /var/lib/apt/lists/*
CMD ["postgres","-c","shared_preload_libraries=pg_cron","-c","cron.database_name=postgres"]
