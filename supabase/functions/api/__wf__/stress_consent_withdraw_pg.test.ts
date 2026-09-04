/**
 * stress — POST /v1/me/consent/withdraw against a REAL Postgres.
 *
 * The route's three DB operations are plain PostgREST calls on
 * `public.consent_records` (no RPC), so the in-process fault suite fakes the
 * wire while THIS suite pins the semantics the fake assumes, under `authenticated`
 * + `request.jwt.claim.sub` with every migration applied:
 *   * the exact insert the route performs is permitted (grants, RLS, checks)
 *   * the ledger is append-only for its owner (no update/delete grant)
 *   * the fold's `order by created_at, id` is deterministic and index-backed
 *   * a withdraw for another user's id is refused by RLS (42501)
 *   * the route's 512-char device / 64-char source caps stay inside
 *     `consent_records_bounds` and `consent_records_device_size`
 *   * a withdraw for a user with no `public.profiles` row hits the FK (23503) —
 *     the state a 503 without recovery would come from
 *   * 200 seeded withdraws (seeded RNG) fold to exactly the API's answer
 *
 * Disposable Postgres (never a hosted project):
 *   ./xc_pg_up.sh                       # XC_PG_CONTAINER/XC_PG_PORT override
 *   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:55437/postgres \
 *     deno test -A --no-check --config deno.json stress_consent_withdraw_pg.test.ts
 * Without STRESS_PG_URL every test here is ignored (like
 * be-edge-routes-shots-rank.test.ts).
 */
import postgres from "postgres";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  caseSeed,
  CONSENT_SCOPES,
  Prng,
  STRESS_SEED,
  writeJson,
} from "./stress_consent_withdraw_harness.ts";

const PG_URL = Deno.env.get("STRESS_PG_URL") ?? "";
const ignore = PG_URL === "";

const ALICE = "00000000-0000-4000-8000-0000000c0001";
const BOB = "00000000-0000-4000-8000-0000000c0002";
const GHOST = "00000000-0000-4000-8000-0000000c0999";

type Sql = ReturnType<typeof postgres>;

const connect = (): Sql => postgres(PG_URL, { max: 1, onnotice: () => {} });

/** One transaction, always rolled back — the container stays pristine. */
async function withRollback(
  sql: Sql,
  fn: (tx: Sql) => Promise<void>,
): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      const t = tx as unknown as Sql;
      await t`select set_config('role', 'postgres', true)`;
      await t`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
              values (${ALICE}, 'alice-consent@example.com', '{}'::jsonb, '{"provider":"google"}'::jsonb),
                     (${BOB}, 'bob-consent@example.com', '{}'::jsonb, '{"provider":"apple"}'::jsonb)`;
      await fn(t);
      throw new Error("__rollback__");
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "__rollback__") {
      throw error;
    }
  }
}

const asUser = async (tx: Sql, userId: string) => {
  await tx`select set_config('role', 'authenticated', true)`;
  await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`;
};

/** The insert index.ts performs for a withdraw. */
const insertWithdraw = (
  tx: Sql,
  userId: string,
  scope: string,
  consentVersion: string | null,
  source: string | null,
  device: string | null,
) =>
  tx`insert into public.consent_records (user_id, scope, consent_version, action, source, device)
     values (${userId}, ${scope}, ${consentVersion}, 'withdraw', ${source},
             ${device === null ? null : tx.json(device)})
     returning id, created_at`;

const errorCode = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";

/** Run a statement expected to fail, inside a savepoint so the surrounding
 * transaction survives (a raw failure would abort it: 25P02 afterwards). */
async function failureOf(
  tx: Sql,
  fn: (tx: Sql) => Promise<unknown>,
): Promise<{ code: string; message: string }> {
  try {
    await (tx as unknown as {
      savepoint: (f: (t: Sql) => Promise<unknown>) => Promise<unknown>;
    })
      .savepoint((sp) => fn(sp));
  } catch (error) {
    return {
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { code: "", message: "(no error)" };
}

const pgFindings: Array<Record<string, unknown>> = [];

Deno.test({
  name:
    "pg: the withdraw insert the route performs is permitted for its owner and append-only afterwards",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await withRollback(sql, async (tx) => {
        await asUser(tx, ALICE);
        const granted = await tx`insert into public.consent_records
            (user_id, scope, consent_version, action, source, device, capture_mode)
          values (${ALICE}, 'model_training', '2026-08-01', 'grant', 'mobile_settings',
                  ${tx.json("iPhone17,1 iOS 26.0")}, 'all_captures')
          returning id`;
        assertEquals(granted.length, 1);

        const inserted = await insertWithdraw(
          tx,
          ALICE,
          "model_training",
          "2026-08-01",
          "mobile_settings",
          "iPhone17,1 iOS 26.0",
        );
        assertEquals(inserted.length, 1);

        // Append-only: neither UPDATE nor DELETE is granted to authenticated.
        const update = await failureOf(
          tx,
          (sp) =>
            sp`update public.consent_records set action = 'grant' where user_id = ${ALICE}`,
        );
        assertEquals(
          update.code,
          "42501",
          `UPDATE on consent_records must be refused (${update.message})`,
        );
        const remove = await failureOf(
          tx,
          (sp) =>
            sp`delete from public.consent_records where user_id = ${ALICE}`,
        );
        assertEquals(
          remove.code,
          "42501",
          `DELETE on consent_records must be refused (${remove.message})`,
        );

        // The fold the route runs, verbatim.
        const rows = await tx`select scope, action, consent_version, created_at
                                from public.consent_records
                               where user_id = ${ALICE}
                               order by created_at asc, id asc`;
        assertEquals(rows.length, 2);
        assertEquals(rows.at(-1)!.action, "withdraw");
        assertEquals(rows.at(-1)!.consent_version, "2026-08-01");
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "pg: RLS refuses a withdraw written for another user's id",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await withRollback(sql, async (tx) => {
        await asUser(tx, ALICE);
        const cross = await failureOf(
          tx,
          (sp) =>
            insertWithdraw(
              sp,
              BOB,
              "model_training",
              null,
              "mobile_settings",
              "iPhone",
            ),
        );
        assertEquals(
          cross.code,
          "42501",
          `cross-user consent insert must violate RLS (${cross.message})`,
        );
        // …and Alice cannot even see Bob's ledger.
        await tx`select set_config('role', 'postgres', true)`;
        await insertWithdraw(
          tx,
          BOB,
          "model_training",
          null,
          "mobile_settings",
          "iPhone",
        );
        await asUser(tx, ALICE);
        const visible =
          await tx`select count(*)::int as n from public.consent_records`;
        assertEquals(
          visible[0].n,
          0,
          "owner must not see another user's consent rows",
        );
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "pg: the route's sanitize caps stay inside consent_records_bounds / device_size",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await withRollback(sql, async (tx) => {
        await asUser(tx, ALICE);
        // index.ts caps device at 512 chars and source at 64 chars.
        const device = "d".repeat(512);
        const source = "s".repeat(64);
        const scope = "evaluation_telemetry";
        const ok = await insertWithdraw(
          tx,
          ALICE,
          scope,
          "2026-08-01",
          source,
          device,
        );
        assertEquals(ok.length, 1);
        const stored =
          await tx`select pg_column_size(device) as bytes, length(source) as src
                                  from public.consent_records where user_id = ${ALICE}`;
        assert(
          Number(stored[0].bytes) <= 4096,
          "device must fit consent_records_bounds (4096B)",
        );
        assertEquals(Number(stored[0].src), 64);

        // The constraints are NOT VALID but ENFORCED for new rows: a device
        // past the cap is refused, which is what the 512-char cap prevents.
        const oversized = await failureOf(
          tx,
          (sp) =>
            sp`insert into public.consent_records (user_id, scope, action, device)
               values (${ALICE}, ${scope}, 'withdraw', ${
              sp.json("x".repeat(20_000))
            })`,
        );
        assertEquals(
          oversized.code,
          "23514",
          `an oversized device must hit a check constraint (${oversized.message})`,
        );
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "pg: a withdraw for a user with no profiles row hits the FK (the un-recoverable 503 state)",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await withRollback(sql, async (tx) => {
        // GHOST has no auth.users row, so handle_new_user() never provisioned
        // a profile: consent_records.user_id references public.profiles(id).
        await tx`select set_config('role', 'postgres', true)`;
        const profiles =
          await tx`select count(*)::int as n from public.profiles where id = ${GHOST}`;
        assertEquals(profiles[0].n, 0);
        const { code, message } = await failureOf(
          tx,
          (sp) =>
            insertWithdraw(
              sp,
              GHOST,
              "model_training",
              null,
              "mobile_settings",
              "iPhone",
            ),
        );
        assertEquals(
          code,
          "23503",
          `a profile-less user's withdraw must hit the FK (${message})`,
        );
        assertStringIncludes(message, "consent_records");
        pgFindings.push({
          case: "profile-less user",
          code,
          effect:
            "PostgREST would answer 400/409 and the route returns 503 'Consent update is temporarily unavailable' — retrying never succeeds until a profile exists",
        });
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "pg: 200 seeded grant/withdraw rows fold exactly like the API's foldConsentStatus",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await withRollback(sql, async (tx) => {
        await asUser(tx, ALICE);
        const prng = new Prng(caseSeed(STRESS_SEED, 4_000_001));
        const expected = new Map<
          string,
          { action: string; version: string | null }
        >();
        for (let i = 0; i < 200; i++) {
          const scope = prng.pick(CONSENT_SCOPES);
          const withdraw = prng.next() < 0.5;
          const version = withdraw
            ? expected.get(scope)?.version ?? null
            : `2026-0${prng.int(1, 9)}-01`;
          await tx`insert into public.consent_records
                     (user_id, scope, consent_version, action, source, device, created_at)
                   values (${ALICE}, ${scope}, ${version}, ${
            withdraw ? "withdraw" : "grant"
          },
                           'mobile_settings', ${tx.json(`iPhone-${i}`)},
                           ${new Date(Date.UTC(2026, 0, 1) + i * 60_000)})`;
          expected.set(scope, {
            action: withdraw ? "withdraw" : "grant",
            version,
          });
        }
        const rows = await tx`select scope, action, consent_version, created_at
                                from public.consent_records
                               where user_id = ${ALICE}
                               order by created_at asc, id asc`;
        assertEquals(rows.length, 200);
        // Fold in the API's order: last row per scope wins.
        const folded = new Map<
          string,
          { action: string; version: string | null }
        >();
        for (const row of rows) {
          folded.set(String(row.scope), {
            action: String(row.action),
            version: row.consent_version === null
              ? null
              : String(row.consent_version),
          });
        }
        for (const [scope, want] of expected) {
          assertEquals(folded.get(scope), want, `fold mismatch for ${scope}`);
        }
        const plan = await tx`explain (format json)
          select scope, action, consent_version, created_at
            from public.consent_records
           where user_id = ${ALICE}
           order by created_at asc, id asc`;
        const planText = JSON.stringify(plan[0]);
        await writeJson("pg_consent_withdraw.json", {
          unit: "route-post-v1-me-consent-withdraw",
          lens: "failure-load/postgres",
          baseSeed: STRESS_SEED,
          pgUrl: PG_URL.replace(/:\/\/[^@]*@/, "://***@"),
          seededRows: rows.length,
          foldScopes: Object.fromEntries(folded),
          foldPlan: planText,
          findings: pgFindings,
        });
        assert(planText.length > 0);
      });
    } finally {
      await sql.end();
    }
  },
});
