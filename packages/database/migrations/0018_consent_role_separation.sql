-- 0018: g10-f23 least-privilege role separation for the consent system.
--
-- Four cluster-wide NOLOGIN group roles express the privilege boundaries;
-- login users (local dev: infra/postgres/init-roles.sql; production: managed
-- credentials) get their access exclusively through membership:
--
--   pickle_migration_owner     schema ops; intended owner of all tables in
--                              deployments where migrations run as a
--                              dedicated role (locally the bootstrap
--                              superuser keeps ownership for back-compat).
--   pickle_application_runtime services/api. Full DML on ordinary tables,
--                              but on the consent ledger only the intended
--                              paths: append + read on consent_record;
--                              insert/select/update (no delete) on
--                              consent_subject (update is required by the
--                              ON CONFLICT upsert; the 0017 immutability
--                              trigger rejects real changes); read-only on
--                              consent_subject_erasure and
--                              schema_migrations. No ownership, so it can
--                              never ALTER the consent schema, disable the
--                              append-only triggers, or TRUNCATE past them.
--   pickle_worker_runtime      services/media-worker. Same consent
--                              restrictions; consent_subject deletion
--                              happens only via the app_user FK cascade,
--                              which executes with the table owner's
--                              privileges, so the worker needs no direct
--                              DELETE on consent tables.
--   pickle_readonly            analytics/debugging: SELECT only.
--
-- Roles are cluster-wide while migrations may run in many schemas (the
-- integration tests run one schema per suite), so creation is idempotent and
-- race-safe; grants are per-schema and re-applied by each migrated schema.

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'pickle_migration_owner',
    'pickle_application_runtime',
    'pickle_worker_runtime',
    'pickle_readonly'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
      EXCEPTION WHEN duplicate_object THEN
        NULL; -- concurrent migration in another schema created it first
      END;
    END IF;
  END LOOP;
END;
$$;

DO $$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format(
    'GRANT USAGE ON SCHEMA %I TO pickle_application_runtime, pickle_worker_runtime, pickle_readonly',
    s);
  EXECUTE format(
    'GRANT ALL ON SCHEMA %I TO pickle_migration_owner',
    s);

  -- Baseline: full DML on ordinary tables for the runtimes, SELECT for
  -- analytics, sequence usage for identity/serial columns.
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO pickle_application_runtime, pickle_worker_runtime',
    s);
  EXECUTE format(
    'GRANT SELECT ON ALL TABLES IN SCHEMA %I TO pickle_readonly',
    s);
  EXECUTE format(
    'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO pickle_application_runtime, pickle_worker_runtime',
    s);

  -- Consent-system carve-outs: the ledger is append-only at the privilege
  -- level too, defense in depth on top of the 0015/0016/0017 triggers.
  EXECUTE format(
    'REVOKE UPDATE, DELETE ON %I.consent_record FROM pickle_application_runtime, pickle_worker_runtime',
    s);
  EXECUTE format(
    'REVOKE DELETE ON %I.consent_subject FROM pickle_application_runtime, pickle_worker_runtime',
    s);
  EXECUTE format(
    'REVOKE INSERT, UPDATE, DELETE ON %I.consent_subject_erasure FROM pickle_application_runtime, pickle_worker_runtime',
    s);
  EXECUTE format(
    'REVOKE INSERT, UPDATE, DELETE ON %I.schema_migrations FROM pickle_application_runtime, pickle_worker_runtime',
    s);
END;
$$;

-- Tables created by future migrations run by the current (owner) role get the
-- same baseline automatically; any new protected table must add its own
-- carve-out in its migration.
DO $$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pickle_application_runtime, pickle_worker_runtime',
    s);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO pickle_readonly',
    s);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO pickle_application_runtime, pickle_worker_runtime',
    s);
END;
$$;
