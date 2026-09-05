/**
 * STRESS (delete-confirm, Postgres side) — the database invariants that
 * `POST /v1/me/delete-confirm` relies on, exercised against a disposable
 * postgres:16 with shim_auth.sql + every migration applied (`./xc_pg_up.sh`).
 *
 * The route itself never calls an RPC: it reads `account_deletion_requests`
 * with maybeSingle() as the user, walks `account_external_credentials` with
 * the service role, and finishes with `auth.admin.deleteUser` — whose whole
 * data-deletion effect is the `auth.users → profiles → *` FK cascade. This
 * suite pins, per seeded user:
 *
 *   PG-A  one challenge row per user (PK) — the /delete-request upsert can
 *         never leave two rows, so maybeSingle() cannot 406/PGRST116;
 *   PG-B  RLS: another user reads 0 rows and cannot re-arm the victim's
 *         challenge (42501); `authenticated` has no path at all to
 *         account_external_credentials (42501 on select and insert);
 *   PG-C  service-role write of the external-credential checkpoint respects
 *         the capture-pair / size CHECKs (23514) and is retry-safe (upsert);
 *   PG-D  the deleteUser cascade — issued from N concurrent connections —
 *         removes exactly one auth row (idempotent: N-1 lanes delete 0),
 *         and afterwards profiles / deletion request / external credentials /
 *         identities / shots are all gone while the free-rating ledger row
 *         SURVIVES (identity-keyed, no FK — "used free ratings stay used");
 *   PG-E  the pg_cron sweep statement removes only day-old expired
 *         challenges (a fresh one for another user stays).
 *
 *   ./xc_pg_up.sh                      # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     STRESS_PG_ITER=200 STRESS_OUT_DIR=/tmp/stress \
 *     deno test -A --no-check --config deno.json stress_delete_confirm_pg.test.ts
 *
 * Without XC_PG_URL the test is `ignore`d (reported as such — never as a
 * pass). Never points at a hosted project.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { Prng } from "./xc_concurrency_harness.ts";
import { iterationSeed } from "./stress_delete_confirm_harness.ts";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ??
  "";
const ITER = Number(Deno.env.get("STRESS_PG_ITER") ?? "20");
const SEED = Number(Deno.env.get("STRESS_SEED") ?? "20260905");
const OUT_DIR = Deno.env.get("STRESS_OUT_DIR") ?? "";

const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "config-1",
};

interface PgRow {
  seed: number;
  userId: string;
  provider: "apple" | "google";
  lanes: number;
  scoredBefore: number;
  deletedRows: number[];
  after: Record<string, number>;
  ledgerBefore: number[];
  ledgerAfter: number[];
  violations: string[];
  verdict: "HELD" | "BROKEN";
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function asService(tx: Tx): Promise<void> {
  await tx.unsafe(`set local role service_role`);
}

/** Returns the SQLSTATE of a failing statement run inside its own savepoint
 * (postgres.js rolls the savepoint back and rethrows), or null on success. */
async function sqlstate(tx: Tx, statement: string): Promise<string | null> {
  try {
    await tx.savepoint(async (sp) => {
      await sp.unsafe(statement);
    });
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

async function createUser(
  sql: Sql,
  userId: string,
  provider: "apple" | "google",
  sub: string,
): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `delete from auth.users u using auth.identities i
      where i.user_id = u.id and i.provider = '${provider}' and i.provider_id = '${sub}'`,
  );
  await sql.unsafe(
    `delete from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('${provider}', '${sub}')`,
  );
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
      values ('${userId}', '${userId}@example.com', '{"provider":"${provider}"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
      values ('${provider}', '${sub}', '${userId}', '{"sub":"${sub}"}')`,
  );
}

async function scoreShots(sql: Sql, userId: string, count: number, prng: Prng) {
  await sql.begin(async (raw) => {
    const tx = raw as unknown as Tx;
    await asUser(tx, userId);
    for (let i = 0; i < count; i++) {
      const permit = await tx.unsafe(
        `select x.result, x.permit_id::text as permit_id
           from public.reserve_analysis_permit('stress-${userId}-${i}') x`,
      );
      assertEquals(String(permit[0].result), "accepted");
      const applied = await tx.unsafe(
        `select public.apply_synced_shot($1::text::jsonb) as result`,
        [
          JSON.stringify({
            id: prng.uuid(),
            analysisPermitId: permit[0].permit_id,
            sessionId: null,
            shotType: "dink",
            cameraView: "side",
            capturedAt: "2026-09-01T10:00:00.000Z",
            startMs: 0,
            contactMs: 100,
            endMs: 200,
            overallScore: 7,
            confidence: 0.9,
            resultKind: "scored",
            phases: [],
            checkpoints: [],
            versionVector: VERSION_VECTOR,
          }),
        ],
      );
      assertEquals(String(applied[0].result), "accepted");
    }
  });
}

async function counts(
  sql: Sql,
  userId: string,
): Promise<Record<string, number>> {
  const one = async (table: string, column = "user_id") =>
    Number(
      (await sql.unsafe(
        `select count(*)::int as n from ${table} where ${column} = '${userId}'`,
      ))[0].n,
    );
  return {
    authUsers: await one("auth.users", "id"),
    identities: await one("auth.identities"),
    profiles: await one("public.profiles", "id"),
    deletionRequests: await one("public.account_deletion_requests"),
    externalCredentials: await one("public.account_external_credentials"),
    shots: await one("public.shots"),
    permits: await one("public.analysis_permits"),
  };
}

async function ledgerFor(sql: Sql, provider: string, sub: string) {
  const rows = await sql.unsafe(
    `select scored_count from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('${provider}', '${sub}')`,
  );
  return rows.map((r) => Number(r.scored_count));
}

/** The exact upsert PostgREST issues for POST /v1/me/delete-request. */
async function armChallenge(tx: Tx, userId: string, challenge: string) {
  await tx.unsafe(
    `insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
      values ('${userId}', '${challenge}', now(), now() + interval '15 minutes')
      on conflict (user_id) do update
        set user_id = excluded.user_id, challenge = excluded.challenge,
            created_at = excluded.created_at, expires_at = excluded.expires_at`,
  );
}

Deno.test({
  name:
    `stress delete-confirm postgres invariants (${ITER} users, seed ${SEED})`,
  ignore: !PG_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(PG_URL, { max: 8 });
    const rows: PgRow[] = [];
    try {
      for (let index = 0; index < ITER; index++) {
        const seed = iterationSeed(SEED, index);
        const prng = new Prng(seed);
        const userId = prng.uuid();
        const intruderId = prng.uuid();
        const provider = prng.next() < 0.5 ? "apple" : "google";
        const sub = `${provider}-sub-${seed}`;
        const lanes = prng.int(2, 5);
        const scored = prng.int(0, 2);
        const violations: string[] = [];
        const inv = (name: string, holds: boolean, detail = "") => {
          if (!holds) violations.push(detail ? `${name}: ${detail}` : name);
        };

        await createUser(sql, userId, provider, sub);
        await createUser(sql, intruderId, "google", `intruder-${seed}`);
        if (scored > 0) await scoreShots(sql, userId, scored, prng);

        // PG-A: arm twice (re-request) → still exactly one row, last challenge wins.
        const challenge1 = prng.uuid();
        const challenge2 = prng.uuid();
        await sql.begin(async (raw) => {
          const tx = raw as unknown as Tx;
          await asUser(tx, userId);
          await armChallenge(tx, userId, challenge1);
          await armChallenge(tx, userId, challenge2);
          const own = await tx.unsafe(
            `select challenge::text as challenge from public.account_deletion_requests
              where user_id = '${userId}'`,
          );
          inv(
            "PG-A one challenge row per user, last upsert wins",
            own.length === 1 && own[0].challenge === challenge2,
            `rows=${own.length}`,
          );
        });

        // PG-B: intruder sees nothing and cannot re-arm the victim; nobody
        // client-side reaches account_external_credentials.
        await sql.begin(async (raw) => {
          const tx = raw as unknown as Tx;
          await asUser(tx, intruderId);
          const seen = await tx.unsafe(
            `select 1 from public.account_deletion_requests where user_id = '${userId}'`,
          );
          inv("PG-B intruder reads 0 victim challenge rows", seen.length === 0);
          const rearm = await sqlstate(
            tx,
            `insert into public.account_deletion_requests (user_id, challenge)
              values ('${userId}', '${prng.uuid()}')
              on conflict (user_id) do update set challenge = excluded.challenge`,
          );
          inv(
            "PG-B intruder re-arm rejected by RLS",
            rearm === "42501",
            `${rearm}`,
          );
          const extRead = await sqlstate(
            tx,
            `select 1 from public.account_external_credentials where user_id = '${userId}'`,
          );
          const extWrite = await sqlstate(
            tx,
            `insert into public.account_external_credentials (user_id) values ('${intruderId}')`,
          );
          inv(
            "PG-B authenticated has no grant on account_external_credentials",
            extRead === "42501" && extWrite === "42501",
            `read=${extRead} write=${extWrite}`,
          );
        });

        // PG-C: service-role checkpoint writes (the route's upsert) + CHECKs.
        const cipher = `v1.${"a".repeat(prng.int(8, 40))}.${
          "b".repeat(prng.int(8, 400))
        }`;
        await sql.begin(async (raw) => {
          const tx = raw as unknown as Tx;
          await asService(tx);
          const pairViolation = await sqlstate(
            tx,
            `insert into public.account_external_credentials (user_id, apple_refresh_token_encrypted)
              values ('${userId}', '${cipher}')`,
          );
          inv(
            "PG-C ciphertext without captured_at rejected (23514)",
            pairViolation === "23514",
            `${pairViolation}`,
          );
          const tooShort = await sqlstate(
            tx,
            `insert into public.account_external_credentials
              (user_id, apple_refresh_token_encrypted, apple_token_captured_at)
              values ('${userId}', 'v1.short', now())`,
          );
          inv(
            "PG-C sub-20-char ciphertext rejected (23514)",
            tooShort === "23514",
            `${tooShort}`,
          );
          const upsert = `insert into public.account_external_credentials
              (user_id, revenuecat_deleted_at, updated_at)
              values ('${userId}', now(), now())
              on conflict (user_id) do update
                set revenuecat_deleted_at = excluded.revenuecat_deleted_at,
                    updated_at = excluded.updated_at`;
          const first = await sqlstate(tx, upsert);
          const second = await sqlstate(tx, upsert);
          inv(
            "PG-C RevenueCat checkpoint upsert is retry-safe",
            first === null && second === null,
            `${first}/${second}`,
          );
          if (provider === "apple") {
            const stamped = await sqlstate(
              tx,
              `update public.account_external_credentials
                  set apple_refresh_token_encrypted = '${cipher}', apple_token_captured_at = now()
                where user_id = '${userId}'`,
            );
            inv(
              "PG-C apple ciphertext + captured_at accepted",
              stamped === null,
              `${stamped}`,
            );
          }
        });

        const before = await counts(sql, userId);
        const ledgerBefore = await ledgerFor(sql, provider, sub);
        inv(
          "pre-delete: profile, challenge, external row present; ledger reflects scored shots",
          before.authUsers === 1 && before.profiles === 1 &&
            before.deletionRequests === 1 && before.externalCredentials === 1 &&
            before.shots === scored &&
            (scored === 0
              ? ledgerBefore.length === 0
              : ledgerBefore.join() === `${scored}`),
          JSON.stringify({ before, ledgerBefore }),
        );

        // PG-D: N concurrent deleteUser cascades (GoTrue deletes auth.users as
        // the auth schema owner) — exactly one removes the row.
        const deletedRows: number[] = [];
        await Promise.all(
          Array.from({ length: lanes }, () =>
            sql.begin(async (raw) => {
              const tx = raw as unknown as Tx;
              const r = await tx.unsafe(
                `with d as (delete from auth.users where id = '${userId}' returning 1)
                  select count(*)::int as n from d`,
              );
              deletedRows.push(Number(r[0].n));
            })),
        );
        const after = await counts(sql, userId);
        const ledgerAfter = await ledgerFor(sql, provider, sub);
        inv(
          "PG-D exactly one lane deleted the auth row, the rest deleted 0",
          deletedRows.filter((n) => n === 1).length === 1 &&
            deletedRows.every((n) => n === 0 || n === 1),
          deletedRows.join(","),
        );
        inv(
          "PG-D cascade removed every user-owned row",
          Object.values(after).every((n) => n === 0),
          JSON.stringify(after),
        );
        inv(
          "PG-D free-rating ledger survives the cascade",
          scored === 0
            ? ledgerAfter.length === 0
            : ledgerAfter.join() === `${scored}`,
          `before=${ledgerBefore} after=${ledgerAfter}`,
        );
        // A second confirm (the replay) finds no challenge row to match.
        const replayRows = await sql.unsafe(
          `select 1 from public.account_deletion_requests where user_id = '${userId}'`,
        );
        inv(
          "PG-D replayed confirm has no challenge to match",
          replayRows.length === 0,
        );

        rows.push({
          seed,
          userId,
          provider,
          lanes,
          scoredBefore: scored,
          deletedRows,
          after,
          ledgerBefore,
          ledgerAfter,
          violations,
          verdict: violations.length === 0 ? "HELD" : "BROKEN",
        });
        await sql.unsafe(`delete from auth.users where id = '${intruderId}'`);
      }

      // PG-E: the pg_cron sweep removes only day-old expired challenges.
      const sweepPrng = new Prng(iterationSeed(SEED, ITER));
      const stale = sweepPrng.uuid();
      const fresh = sweepPrng.uuid();
      await createUser(sql, stale, "google", `stale-${SEED}`);
      await createUser(sql, fresh, "google", `fresh-${SEED}`);
      await sql.unsafe(
        `insert into public.account_deletion_requests (user_id, created_at, expires_at)
          values ('${stale}', now() - interval '3 days', now() - interval '2 days'),
                 ('${fresh}', now(), now() + interval '15 minutes')`,
      );
      await sql.unsafe(
        `delete from public.account_deletion_requests where expires_at < now() - interval '1 day'`,
      );
      const survivors = await sql.unsafe(
        `select user_id::text as user_id from public.account_deletion_requests
          where user_id in ('${stale}', '${fresh}')`,
      );
      const sweepHeld = survivors.length === 1 &&
        survivors[0].user_id === fresh;
      await sql.unsafe(
        `delete from auth.users where id in ('${stale}', '${fresh}')`,
      );

      const broken = rows.filter((r) => r.verdict === "BROKEN");
      const report = {
        campaign: "stress_delete_confirm_pg",
        seed: SEED,
        iterations: rows.length,
        verdicts: {
          HELD: rows.length - broken.length,
          BROKEN: broken.length,
        },
        sweep: sweepHeld ? "HELD" : "BROKEN",
        broken: broken.map((r) => ({ seed: r.seed, violations: r.violations })),
        rows,
      };
      if (OUT_DIR) {
        await Deno.mkdir(OUT_DIR, { recursive: true });
        const path = `${OUT_DIR}/stress_delete_confirm_pg_${SEED}.json`;
        await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
        console.log(`[stress-pg] wrote ${path}`);
      }
      console.log(
        `[stress-pg] users=${rows.length} verdicts=${
          JSON.stringify(report.verdicts)
        } sweep=${report.sweep}`,
      );
      for (const r of broken) {
        console.log(
          `[stress-pg] BROKEN seed=${r.seed}: ${r.violations.join(" | ")}`,
        );
      }
      assert(
        sweepHeld,
        `PG-E sweep kept ${survivors.map((s) => s.user_id).join(",")}`,
      );
      assertEquals(broken.length, 0, `${broken.length} BROKEN users`);
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
});
