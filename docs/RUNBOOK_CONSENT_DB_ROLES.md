# RUNBOOK — Consent DB Role Separation (Provisioning, Rotation, Migration)

Operations runbook for deploying the least-privilege Postgres role separation
protecting the consent system (migration `0018_consent_role_separation.sql`,
workstreams g10/g11/g12-f23). Audience: whoever holds the production/staging
AWS + database admin credentials. Everything in this document except the final
credential application has been built and tested in-repo.

## 1. Role model (what exists in code today)

Four cluster-wide **NOLOGIN group roles** carry the privileges (created and
granted by migration 0018, idempotently):

| Group role                   | Purpose                                  | Consent-system boundary                                                                                                         |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `pickle_migration_owner`     | owns all schema objects; runs migrations | full DDL; the only role that can alter consent tables or their triggers                                                         |
| `pickle_application_runtime` | services/api runtime                     | INSERT/SELECT only on `consent_record`; no DELETE on `consent_subject`; read-only `consent_subject_erasure`/`schema_migrations` |
| `pickle_worker_runtime`      | services/media-worker                    | same consent carve-outs as application runtime                                                                                  |
| `pickle_readonly`            | dashboards/debugging                     | SELECT only, everywhere                                                                                                         |

**LOGIN users** hold membership in exactly one group role and own nothing:
`pickle_app`, `pickle_worker`, `pickle_migrator`, `pickle_ro`. Locally they are
created by `infra/postgres/init-roles.sql` (docker initdb). In
staging/production they must be created by an operator (§3) — the AWS Terraform
provider cannot create in-database roles.

Services read their credential from a single environment variable:
`DATABASE_URL_APP` (services/api/src/config.ts) and `DATABASE_URL_WORKER`
(services/media-worker/src/main.ts), each falling back to `DATABASE_URL` for
single-credential local setups. Migrations use the migrator credential via the
`@pickle/database` CLI (`pnpm db:migrate` with `DATABASE_URL` set to the
migrator URL).

Evidence the boundary holds: `packages/database/test/roles.integration.test.ts`
(g10; 7 tests, 22 denied-operation assertions via SET ROLE) and
`packages/database/test/roles.destructive.integration.test.ts` (g11; 8 tests,
63 denied-operation assertions over real password-authenticated connections as
the login users, including all 18 migrations run by the migrator login).

## 2. IaC wiring (what Terraform manages)

`infra/terraform/modules/data` creates, per environment:

- `random_password.db_role["app"|"worker"|"migrator"|"readonly"]` — 32-char passwords.
- Secrets Manager secrets `<env>/db-url-app`, `/db-url-worker`, `/db-url-migrator`,
  `/db-url-readonly`, each holding a **full connection URL**
  (`postgres://<user>:<password>@<rds-endpoint>:5432/pickle`), KMS-encrypted
  with the data key.

`infra/terraform/modules/compute` injects them as ECS container secrets:

- api task → `DATABASE_URL_APP` from the app secret.
- media-worker task → `DATABASE_URL_WORKER` from the worker secret.
- The task **execution** role is granted `secretsmanager:GetSecretValue` on
  exactly those two secrets plus `kms:Decrypt` on the data key. The migrator
  and readonly secrets are deliberately NOT readable by service tasks.

`terraform validate` passes on `infra/terraform/envs/staging` (no AWS
credentials required). `terraform apply` is gated on the production/staging
AWS credentials — external.

## 3. Role provisioning procedure (staging/production)

Run once per environment, after `terraform apply` has created the RDS instance
and the secrets, from a host inside the VPC (bastion / ECS exec / SSM tunnel):

1. Fetch the master credential and the generated role passwords:

   ```bash
   aws secretsmanager get-secret-value --secret-id <env>/db-master --query SecretString --output text
   aws secretsmanager get-secret-value --secret-id <env>/db-url-app --query SecretString --output text
   # …repeat for db-url-worker, db-url-migrator, db-url-readonly
   ```

2. As `pickle_admin` (RDS master user), create the group roles and login users.
   The group-role block is identical to migration 0018's; the login-user block
   mirrors `infra/postgres/init-roles.sql` but with the Secrets Manager
   passwords instead of dev defaults:

   ```sql
   -- group roles (idempotent; also created by migration 0018)
   DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pickle_migration_owner') THEN CREATE ROLE pickle_migration_owner NOLOGIN; END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pickle_application_runtime') THEN CREATE ROLE pickle_application_runtime NOLOGIN; END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pickle_worker_runtime') THEN CREATE ROLE pickle_worker_runtime NOLOGIN; END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pickle_readonly') THEN CREATE ROLE pickle_readonly NOLOGIN; END IF;
   END $$;

   -- login users (passwords from the Secrets Manager URLs fetched above)
   CREATE ROLE pickle_migrator LOGIN PASSWORD '<from db-url-migrator>' IN ROLE pickle_migration_owner;
   CREATE ROLE pickle_app      LOGIN PASSWORD '<from db-url-app>'      IN ROLE pickle_application_runtime;
   CREATE ROLE pickle_worker   LOGIN PASSWORD '<from db-url-worker>'   IN ROLE pickle_worker_runtime;
   CREATE ROLE pickle_ro       LOGIN PASSWORD '<from db-url-readonly>' IN ROLE pickle_readonly;
   ```

3. Pre-create the pgcrypto extension as admin (measured g11 prerequisite:
   `CREATE EXTENSION` needs CREATE on the database, which the migration owner
   deliberately lacks):

   ```sql
   CREATE SCHEMA IF NOT EXISTS pickle_ext;
   CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA pickle_ext;
   ```

4. Run migrations as the migrator (§5), which applies 0018 and grants the
   group-role privileges.

5. Verify (as admin):

   ```sql
   SELECT rolname, rolsuper, rolcreaterole FROM pg_roles WHERE rolname LIKE 'pickle_%';
   SELECT tableowner, count(*) FROM pg_tables WHERE schemaname = 'public' GROUP BY 1;
   -- expect: no pickle_* role with rolsuper/rolcreaterole; tables owned by pickle_migration_owner
   ```

   and as `pickle_app` (connection string from the secret), expect errors:

   ```sql
   UPDATE consent_record SET record_payload = '{}' WHERE false;  -- permission denied
   ALTER TABLE consent_record DISABLE TRIGGER ALL;               -- must be owner
   ```

## 4. Credential rotation

Rotation changes only the password, never the privilege grants (privileges
live on the NOLOGIN group roles; membership survives `ALTER ROLE … PASSWORD`).

1. Taint/regenerate the password in Terraform:
   `terraform apply -replace='module.data.random_password.db_role["app"]'`
   (updates the secret version with the new URL).
2. Apply it in the database as admin:
   `ALTER ROLE pickle_app PASSWORD '<new password>';`
3. Bounce the consuming service so ECS re-resolves the secret at task launch
   (container secrets are read at start, not live):
   `aws ecs update-service --cluster <env> --service api --force-new-deployment`.
4. Verify the old credential fails and the new task is healthy
   (`/v1/health`).

Order matters: between steps 1 and 2 the secret and the database disagree —
new tasks would fail auth. Do 2 immediately after 1, then 3. Rotate one role
at a time. The same procedure applies to `pickle_worker` (bounce media-worker),
`pickle_migrator`, and `pickle_ro` (no service bounce needed).

The RDS master credential rotates independently
(`terraform apply -replace=module.data.random_password.db_master` plus RDS
`modify-db-instance`); it is used only for provisioning/break-glass, never by
services.

## 5. Migration procedure (deploy-time)

Migrations run as a deliberate operator step with the migrator credential —
they are intentionally NOT wired into ECS task definitions, so a compromised
runtime can never replay DDL:

```bash
DATABASE_URL="$(aws secretsmanager get-secret-value --secret-id <env>/db-url-migrator --query SecretString --output text)" \
  pnpm db:migrate
```

Properties (all measured in the g11 destructive suite against Postgres 16):

- All 18 migrations run under `pickle_migration_owner` privileges; no
  superuser needed (only the pgcrypto pre-creation of §3.3 is admin-level).
- Every created table is owned by `pickle_migration_owner`; runtime roles own
  nothing and cannot ALTER the consent schema or disable its append-only
  triggers.
- The migration runner is transactional per file with checksum verification
  (`packages/database/src/migrate.ts`); re-running is a no-op.

Deploy order: `terraform apply` (infra + secrets) → provision roles (§3, first
time only) → run migrations (this section) → deploy/bounce services.

## 6. Residual risk statement (honest)

- **Cloud superuser remains BLOCKED_EXTERNAL.** The RDS master user
  (`pickle_admin`, `rds_superuser`) and the AWS account principals that can
  read the master secret or modify the instance can still bypass every
  boundary here — rewrite consent history, drop triggers, alter roles. That
  power cannot be removed from inside this repository; it is constrained only
  by AWS IAM policy, CloudTrail auditing, and organizational access control on
  the production account. No production AWS credentials exist in this repo, so
  none of §3–§5 has been executed against a real cloud environment: the
  internal preparation (roles, grants, tests, IaC, this runbook) is complete,
  and **only the production credential application is external**.
- ECS execution-role scoping limits which tasks can read which DB secret, but
  anyone with `iam:*`/`secretsmanager:*` in the account can widen it.
- Rotation is manual (§4). Until automated (e.g. Secrets Manager rotation
  lambdas), stale credentials are a process risk, not a technical control.
- The boundary is proven on local/CI Postgres 16
  (`roles.destructive.integration.test.ts`); RDS parameter-group or pg_hba
  differences are not exercised until first staging apply.
