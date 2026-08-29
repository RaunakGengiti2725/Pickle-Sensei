-- Local-dev bootstrap for least-privilege connection roles (g10-f23).
-- Mounted into /docker-entrypoint-initdb.d by docker-compose.yml, so it runs
-- once when a container initializes an empty data directory. Existing dev
-- volumes keep working unchanged (everything still works through the `pickle`
-- superuser); to pick these roles up on an old volume, either recreate the
-- volume or run this file manually: psql -U pickle -d pickle_dev -f <file>.
--
-- The group roles carry the privileges (granted by migration
-- 0018_consent_role_separation.sql); the login users below only hold
-- membership. Passwords here are non-secret local-dev defaults, same policy
-- as docker-compose.yml.

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
      EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
    END IF;
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pickle_app') THEN
    CREATE ROLE pickle_app LOGIN PASSWORD 'pickle_app_password' IN ROLE pickle_application_runtime;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pickle_worker') THEN
    CREATE ROLE pickle_worker LOGIN PASSWORD 'pickle_worker_password' IN ROLE pickle_worker_runtime;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pickle_ro') THEN
    CREATE ROLE pickle_ro LOGIN PASSWORD 'pickle_ro_password' IN ROLE pickle_readonly;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pickle_migrator') THEN
    CREATE ROLE pickle_migrator LOGIN PASSWORD 'pickle_migrator_password' IN ROLE pickle_migration_owner;
  END IF;
END;
$$;
