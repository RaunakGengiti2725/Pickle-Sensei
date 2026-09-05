/**
 * stress route-post-v1-account-bootstrap — DIRECT Postgres half.
 *
 * The fuzz campaign (stress_route_post_v1_account_bootstrap_fuzz_boundary
 * .test.ts) drives the real handler over a stubbed PostgREST. This file
 * replays the exact SQL the route's three database touches become, against a
 * disposable postgres:16 with shim_auth.sql + every migration applied
 * (./xc_pg_up.sh), as the roles PostgREST would use:
 *
 *   readProfile()      → select … from profiles where id = <uid>        (authenticated)
 *   provider correction→ update profiles set provider = … where id = <uid> (authenticated)
 *   secure Apple path  → upsert account_external_credentials on user_id   (service_role)
 *
 * and asserts the invariants the route silently relies on: the signup trigger
 * populates the row the route reads; RLS confines both read and write to the
 * caller; the column grant covers `provider` (a 42501 here would be a
 * swallowed error, see index.ts bootstrapAccount); the credential upsert is
 * idempotent (one row after N replays of the same sign-in — duplicate
 * delivery), refuses plaintext-sized / unpaired tokens, and is unreachable
 * from client roles; deleting the user cascades every row.
 *
 *   ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     STRESS_OUT_DIR=/tmp/stress-pg deno test -A --no-check --config deno.json \
 *     stress_route_post_v1_account_bootstrap_pg.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 * Seeded (STRESS_SEED): user ids / identity subjects / token bytes replay.
 */
import postgres from "postgres";
import { assert, assertMatch } from "@std/assert";
import { envInt, Prng } from "./xc_concurrency_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const SEED = envInt("STRESS_SEED", 20260905);
const REPLAYS = envInt("STRESS_PG_REPLAYS", 25);
const OUT_DIR = Deno.env.get("STRESS_OUT_DIR") ?? "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

interface Check {
  name: string;
  held: boolean;
  detail: string;
}

const checks: Check[] = [];
function record(name: string, held: boolean, detail: string): void {
  checks.push({ name, held, detail });
  assert(held, `${name}: ${detail}`);
}

async function writeEvidence(): Promise<void> {
  if (!OUT_DIR) return;
  await Deno.mkdir(OUT_DIR, { recursive: true });
  await Deno.writeTextFile(
    `${OUT_DIR}/pg_bootstrap_paths.json`,
    JSON.stringify(
      {
        seed: SEED,
        replays: REPLAYS,
        pgUrlHost: new URL(PG_URL).host,
        checks,
        replay:
          `XC_PG_URL=<url> STRESS_SEED=${SEED} STRESS_PG_REPLAYS=${REPLAYS} deno test -A --no-check --config deno.json stress_route_post_v1_account_bootstrap_pg.test.ts`,
      },
      null,
      2,
    ),
  );
}

async function asRole(
  tx: Tx,
  role: "authenticated" | "service_role" | "anon",
  userId?: string,
) {
  await tx.unsafe(`set local role ${role}`);
  if (userId) await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function createUser(
  sql: Sql,
  userId: string,
  provider: string,
  sub: string,
) {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `delete from auth.users u using auth.identities i
      where i.user_id = u.id and i.provider = '${provider}' and i.provider_id = '${sub}'`,
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

function sqlstate(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
}

async function expectSqlstate(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "ok";
  } catch (error) {
    return sqlstate(error) || "error";
  }
}

/** The route's readProfile() select list, verbatim. */
const PROFILE_SELECT =
  "id, email, onboarding_state, provider, skill_level, handedness, primary_goal, biggest_problem, focus_checkpoint, first_name, gender";

/** Shape of what encryptAppleRefreshToken() stores: v1.<iv>.<ciphertext+tag>. */
function ciphertextLike(rng: Prng, bytes: number): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let iv = "";
  for (let i = 0; i < 16; i++) iv += alphabet[rng.int(0, 63)];
  let ct = "";
  for (let i = 0; i < bytes; i++) ct += alphabet[rng.int(0, 63)];
  return `v1.${iv}.${ct}`;
}

Deno.test({
  name:
    "stress bootstrap/pg: readProfile() and the provider correction run under RLS with the granted columns",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    const rng = new Prng(SEED);
    const google = rng.uuid();
    const apple = rng.uuid();
    const googleSub = `g-${rng.int(1, 2 ** 31)}`;
    const appleSub = `apple-${rng.int(1, 2 ** 31)}`;
    try {
      await createUser(sql, google, "google", googleSub);
      await createUser(sql, apple, "apple", appleSub);

      // 1. The signup trigger populated the row the route reads.
      await sql.begin(async (tx) => {
        await asRole(tx as unknown as Tx, "authenticated", google);
        const rows = await tx.unsafe(
          `select ${PROFILE_SELECT} from public.profiles where id = '${google}'`,
        );
        record(
          "signup trigger creates the profile readProfile() selects",
          rows.length === 1 && rows[0].provider === "google" &&
            rows[0].onboarding_state === "pending",
          JSON.stringify(rows[0] ?? null),
        );
        const other = await tx.unsafe(
          `select id from public.profiles where id = '${apple}'`,
        );
        record(
          "RLS hides another user's profile from readProfile()",
          other.length === 0,
          `${other.length} rows`,
        );
        const all = await tx.unsafe(
          `select count(*)::int as n from public.profiles`,
        );
        record(
          "RLS: unfiltered select sees exactly the caller's row",
          Number(all[0].n) === 1,
          `${all[0].n} rows`,
        );
      });

      // 2. The provider-correcting update the route issues when the sign-in
      //    provider differs from the stored one (Apple ID token on a row
      //    created by Google). Column grant must include `provider`.
      let patched = 0;
      await sql.begin(async (tx) => {
        await asRole(tx as unknown as Tx, "authenticated", google);
        const r = await tx.unsafe(
          `update public.profiles set provider = 'apple' where id = '${google}'`,
        );
        patched = r.count;
      });
      record(
        "provider correction UPDATE is granted and hits exactly one row",
        patched === 1,
        `${patched} rows`,
      );
      const after = await sql.unsafe(
        `select provider from public.profiles where id = '${google}'`,
      );
      record(
        "provider correction persisted",
        after[0].provider === "apple",
        String(after[0].provider),
      );

      let crossPatched = -1;
      await sql.begin(async (tx) => {
        await asRole(tx as unknown as Tx, "authenticated", google);
        const r = await tx.unsafe(
          `update public.profiles set provider = 'google' where id = '${apple}'`,
        );
        crossPatched = r.count;
      });
      record(
        "RLS: provider UPDATE on another user's row touches 0 rows",
        crossPatched === 0,
        `${crossPatched} rows`,
      );
      const untouched = await sql.unsafe(
        `select provider from public.profiles where id = '${apple}'`,
      );
      record(
        "other user's provider unchanged",
        untouched[0].provider === "apple",
        String(untouched[0].provider),
      );

      // 3. Defense in depth: columns the route never writes are not granted,
      //    so a future accidental write surfaces as 42501 instead of landing.
      const emailWrite = await expectSqlstate(() =>
        sql.begin(async (tx) => {
          await asRole(tx as unknown as Tx, "authenticated", google);
          await tx.unsafe(
            `update public.profiles set email = 'x@example.com' where id = '${google}'`,
          );
        })
      );
      record(
        "authenticated cannot update profiles.email (42501)",
        emailWrite === "42501",
        emailWrite,
      );
      const idWrite = await expectSqlstate(() =>
        sql.begin(async (tx) => {
          await asRole(tx as unknown as Tx, "authenticated", google);
          await tx.unsafe(
            `update public.profiles set id = '${apple}' where id = '${google}'`,
          );
        })
      );
      record(
        "authenticated cannot rewrite profiles.id (42501)",
        idWrite === "42501",
        idWrite,
      );
      const anonRead = await expectSqlstate(() =>
        sql.begin(async (tx) => {
          await asRole(tx as unknown as Tx, "anon");
          await tx.unsafe(`select id from public.profiles limit 1`);
        })
      );
      record(
        "anon cannot read profiles (42501)",
        anonRead === "42501",
        anonRead,
      );
    } finally {
      await sql.unsafe(
        `delete from auth.users where id in ('${google}', '${apple}')`,
      );
      await sql.end();
      await writeEvidence();
    }
  },
});

Deno.test({
  name:
    "stress bootstrap/pg: secure Apple credential upsert is service-only, idempotent under replay, and constraint-checked",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    const rng = new Prng(SEED ^ 0x5eed);
    const user = rng.uuid();
    const sub = `apple-${rng.int(1, 2 ** 31)}`;
    try {
      await createUser(sql, user, "apple", sub);

      // Client roles never see the table (the route uses the service key).
      for (const role of ["authenticated", "anon"] as const) {
        const read = await expectSqlstate(() =>
          sql.begin(async (tx) => {
            await asRole(
              tx as unknown as Tx,
              role,
              role === "authenticated" ? user : undefined,
            );
            await tx.unsafe(
              `select user_id from public.account_external_credentials`,
            );
          })
        );
        record(
          `${role} cannot read account_external_credentials (42501)`,
          read === "42501",
          read,
        );
        const write = await expectSqlstate(() =>
          sql.begin(async (tx) => {
            await asRole(
              tx as unknown as Tx,
              role,
              role === "authenticated" ? user : undefined,
            );
            await tx.unsafe(
              `insert into public.account_external_credentials (user_id, apple_refresh_token_encrypted, apple_token_captured_at)
               values ('${user}', '${ciphertextLike(rng, 48)}', now())`,
            );
          })
        );
        record(
          `${role} cannot write account_external_credentials (42501)`,
          write === "42501",
          write,
        );
      }

      // The route's upsert, replayed REPLAYS times for the same user (the same
      // sign-in delivered again, or a re-bootstrap with a fresh code) — one
      // row, last token wins, apple_revoked_at cleared.
      const upsert = (token: string, capturedAt: string) =>
        sql.begin(async (tx) => {
          await asRole(tx as unknown as Tx, "service_role");
          await tx.unsafe(
            `select set_config('request.jwt.claim.role', 'service_role', true)`,
          );
          await tx.unsafe(
            `insert into public.account_external_credentials
               (user_id, apple_refresh_token_encrypted, apple_token_captured_at, apple_revoked_at, updated_at)
             values ('${user}', '${token}', '${capturedAt}', null, '${capturedAt}')
             on conflict (user_id) do update set
               apple_refresh_token_encrypted = excluded.apple_refresh_token_encrypted,
               apple_token_captured_at = excluded.apple_token_captured_at,
               apple_revoked_at = excluded.apple_revoked_at,
               updated_at = excluded.updated_at`,
          );
        });

      let lastToken = "";
      const base = Date.UTC(2026, 8, 5, 0, 0, 0);
      for (let i = 0; i < REPLAYS; i++) {
        lastToken = ciphertextLike(rng, rng.int(24, 400));
        await upsert(lastToken, new Date(base + i * 1000).toISOString());
      }
      const rows = await sql.unsafe(
        `select user_id, apple_refresh_token_encrypted, apple_token_captured_at, apple_revoked_at
           from public.account_external_credentials where user_id = '${user}'`,
      );
      record(
        `${REPLAYS} replayed upserts leave exactly one credential row (idempotent on user_id)`,
        rows.length === 1,
        `${rows.length} rows`,
      );
      record(
        "last replay wins",
        rows[0].apple_refresh_token_encrypted === lastToken,
        String(rows[0].apple_refresh_token_encrypted).slice(0, 24),
      );
      record(
        "apple_revoked_at cleared by the upsert",
        rows[0].apple_revoked_at === null,
        String(rows[0].apple_revoked_at),
      );

      // Revoked, then re-signed-in: the upsert must un-revoke.
      await sql.unsafe(
        `update public.account_external_credentials set apple_revoked_at = now() where user_id = '${user}'`,
      );
      await upsert(
        ciphertextLike(rng, 64),
        new Date(base + REPLAYS * 1000).toISOString(),
      );
      const reSigned = await sql.unsafe(
        `select apple_revoked_at from public.account_external_credentials where user_id = '${user}'`,
      );
      record(
        "re-sign-in after revocation clears apple_revoked_at",
        reSigned[0].apple_revoked_at === null,
        String(reSigned[0].apple_revoked_at),
      );

      // Constraints the encrypted format relies on (20260902140000).
      const tooShort = await expectSqlstate(() =>
        upsert("v1.short", new Date(base).toISOString())
      );
      record(
        "token shorter than 20 chars refused (23514)",
        tooShort === "23514",
        tooShort,
      );
      const tooLong = await expectSqlstate(() =>
        upsert(ciphertextLike(rng, 8192), new Date(base).toISOString())
      );
      record(
        "token longer than 8192 chars refused (23514)",
        tooLong === "23514",
        tooLong,
      );
      const unpaired = await expectSqlstate(() =>
        sql.begin(async (tx) => {
          await asRole(tx as unknown as Tx, "service_role");
          await tx.unsafe(
            `update public.account_external_credentials set apple_token_captured_at = null where user_id = '${user}'`,
          );
        })
      );
      record(
        "token without captured_at refused (23514)",
        unpaired === "23514",
        unpaired,
      );
      const orphan = await expectSqlstate(() =>
        sql.begin(async (tx) => {
          await asRole(tx as unknown as Tx, "service_role");
          await tx.unsafe(
            `insert into public.account_external_credentials (user_id) values ('${rng.uuid()}')`,
          );
        })
      );
      record(
        "credential row for a user without a profile refused (23503)",
        orphan === "23503",
        orphan,
      );
      const persisted = await sql.unsafe(
        `select count(*)::int as n from public.account_external_credentials where user_id = '${user}'`,
      );
      record(
        "refused writes left the single row intact",
        Number(persisted[0].n) === 1,
        `${persisted[0].n} rows`,
      );

      // Account deletion cascades the credential with the profile.
      await sql.unsafe(`delete from auth.users where id = '${user}'`);
      const gone = await sql.unsafe(
        `select (select count(*) from public.profiles where id = '${user}')::int as profiles,
                (select count(*) from public.account_external_credentials where user_id = '${user}')::int as creds`,
      );
      record(
        "deleting auth.users cascades profile and credential",
        Number(gone[0].profiles) === 0 && Number(gone[0].creds) === 0,
        JSON.stringify(gone[0]),
      );
      assertMatch(lastToken, /^v1\./);
    } finally {
      await sql.unsafe(`delete from auth.users where id = '${user}'`);
      await sql.end();
      await writeEvidence();
    }
  },
});
