// STRESS — POST /v1/account/bootstrap — the Postgres half (lens failure-load).
//
// bootstrap calls no RPC; its database surface is (a) the profile row that
// `handle_new_user()` provisions on the auth.users insert GoTrue performs
// during signInWithIdToken, (b) `readProfile()`'s exact column list read as
// the user under RLS, (c) the provider re-stamp UPDATE as the user, and
// (d) the service-role upsert of the encrypted Apple refresh token into
// account_external_credentials. This file drives those statements against a
// disposable postgres:16 with shim_auth.sql + EVERY migration applied
// (./xc_pg_up.sh) as the same roles PostgREST would use, at STRESS_ITER
// users, and races the credential upsert from N lanes (two devices
// bootstrapping the same Apple ID at once = duplicate delivery).
//
//   ./xc_pg_up.sh                       # prints XC_PG_URL
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     STRESS_ITER=1000 STRESS_OUT_DIR=/tmp/stress/ deno test -A --no-check \
//     --config deno.json stress_bootstrap_pg.test.ts
//
// Without XC_PG_URL (alias STRESS_PG_URL / PICKLE_AUDIT_PG_URL) the test is
// `ignore`d — an ignored run is NOT a pass.

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  latencyStats,
  Prng,
  STRESS_ITER,
  STRESS_SEED,
  uuidFor,
  writeReport,
} from "./stress_bootstrap_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("STRESS_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ??
  "";
const ignore = PG_URL === "";
const LANES = 16;

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

/** readProfile()'s select list, verbatim (index.ts). */
const PROFILE_COLUMNS =
  "id, email, onboarding_state, provider, skill_level, handedness, primary_goal, biggest_problem, focus_checkpoint, first_name, gender";

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function asServiceRole(tx: Tx): Promise<void> {
  await tx.unsafe(`set local role service_role`);
}

function sqlError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const e = error as { code?: string; message?: string };
    return `${e.code ?? "?"} ${e.message ?? ""}`.trim();
  }
  return String(error);
}

/** Fake ciphertext in the exact shape encryptAppleRefreshToken() produces. */
function fakeCiphertext(prng: Prng): string {
  const b64 = (n: number) => {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = prng.int(0, 255);
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(
      /\//g,
      "_",
    ).replace(/=+$/, "");
  };
  return `v1.${b64(12)}.${b64(48)}`;
}

interface UserRow {
  i: number;
  userId: string;
  provider: string;
  triggerMs: number;
  readMs: number;
  restampMs: number;
  upsertMs: number | null;
}

Deno.test({
  name:
    "stress/bootstrap pg: handle_new_user trigger, readProfile under RLS, provider re-stamp, Apple credential upsert (postgres:16 + all migrations)",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const sql = postgres(PG_URL, { max: LANES + 2 });
    const prng = new Prng(STRESS_SEED ^ 0x50475f42);
    const report: Record<string, unknown> = {
      unit: "route-post-v1-account-bootstrap",
      lens: "failure-load",
      plane: "postgres:16 + shim_auth.sql + every supabase/migrations/*.sql",
      seed: STRESS_SEED,
      users: STRESS_ITER,
      lanes: LANES,
      replay:
        `XC_PG_URL=<url> STRESS_SEED=${STRESS_SEED} STRESS_ITER=${STRESS_ITER} deno test -A --no-check --config deno.json stress_bootstrap_pg.test.ts`,
    };
    const rows: UserRow[] = [];
    let executed = 0;
    const findings: string[] = [];
    try {
      const version = await sql.unsafe(`select version()`);
      report.serverVersion = version[0].version;
      const migrations = await sql.unsafe(
        `select count(*)::int as n from pg_proc where proname in ('handle_new_user','access_state','apply_synced_shot','lifetime_scored_count')`,
      );
      assertEquals(
        migrations[0].n,
        4,
        "migrations applied (bootstrap trigger + hot-path RPCs present)",
      );

      // ── 1. STRESS_ITER first sign-ins: trigger → read → re-stamp → upsert ─
      await t.step(
        `${STRESS_ITER} users: handle_new_user() → readProfile columns as user → provider re-stamp → credential upsert`,
        async () => {
          for (let i = 0; i < STRESS_ITER; i++) {
            const provider = prng.int(0, 99) < 35 ? "apple" : "google";
            const userId = uuidFor(`pg:${STRESS_SEED}:${i}`);
            await sql.unsafe(`delete from auth.users where id = '${userId}'`);

            const t0 = performance.now();
            await sql.unsafe(
              `insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
               values ('${userId}', 'u${i}@example.com', '{"provider":"${provider}","providers":["${provider}"]}', '{"full_name":"User ${i}"}')`,
            );
            const triggerMs = performance.now() - t0;

            const t1 = performance.now();
            const profile = await sql.begin(async (tx) => {
              await asUser(tx, userId);
              return await tx.unsafe(
                `select ${PROFILE_COLUMNS} from public.profiles where id = '${userId}'`,
              );
            });
            const readMs = performance.now() - t1;
            executed += 1;
            assertEquals(profile.length, 1, `i=${i}: profile visible`);
            assertEquals(profile[0].provider, provider);
            assertEquals(profile[0].onboarding_state, "pending");
            assertEquals(profile[0].email, `u${i}@example.com`);

            // Provider re-stamp: only when the stamp differs (route logic).
            const other = provider === "apple" ? "google" : "apple";
            const t2 = performance.now();
            const updated = await sql.begin(async (tx) => {
              await asUser(tx, userId);
              return await tx.unsafe(
                `update public.profiles set provider = '${other}' where id = '${userId}' returning id`,
              );
            });
            const restampMs = performance.now() - t2;
            executed += 1;
            assertEquals(updated.length, 1, `i=${i}: re-stamp updates 1 row`);

            let upsertMs: number | null = null;
            if (provider === "apple") {
              const cipher = fakeCiphertext(prng);
              const t3 = performance.now();
              await sql.begin(async (tx) => {
                await asServiceRole(tx);
                await tx.unsafe(
                  `insert into public.account_external_credentials
                     (user_id, apple_refresh_token_encrypted, apple_token_captured_at, apple_revoked_at, updated_at)
                   values ('${userId}', '${cipher}', now(), null, now())
                   on conflict (user_id) do update set
                     apple_refresh_token_encrypted = excluded.apple_refresh_token_encrypted,
                     apple_token_captured_at = excluded.apple_token_captured_at,
                     apple_revoked_at = excluded.apple_revoked_at,
                     updated_at = excluded.updated_at`,
                );
              });
              upsertMs = performance.now() - t3;
              executed += 1;
            }
            rows.push({
              i,
              userId,
              provider,
              triggerMs,
              readMs,
              restampMs,
              upsertMs,
            });
          }
          report.latencyMs = {
            trigger: latencyStats(rows.map((r) => r.triggerMs)),
            readProfile: latencyStats(rows.map((r) => r.readMs)),
            restamp: latencyStats(rows.map((r) => r.restampMs)),
            credentialUpsert: latencyStats(
              rows.flatMap((r) => (r.upsertMs === null ? [] : [r.upsertMs])),
            ),
          };
        },
      );

      const [a, b] = rows;
      // ── 2. RLS: a user cannot read or re-stamp another user's profile ─────
      await t.step(
        "RLS: foreign profile invisible and not updatable",
        async () => {
          const foreign = await sql.begin(async (tx) => {
            await asUser(tx, a.userId);
            const seen = await tx.unsafe(
              `select ${PROFILE_COLUMNS} from public.profiles where id = '${b.userId}'`,
            );
            const all = await tx.unsafe(
              `select count(*)::int as n from public.profiles`,
            );
            const stamped = await tx.unsafe(
              `update public.profiles set provider = 'apple' where id = '${b.userId}' returning id`,
            );
            return {
              seen: seen.length,
              all: all[0].n,
              stamped: stamped.length,
            };
          });
          executed += 3;
          report.rls = foreign;
          assertEquals(foreign.seen, 0, "foreign row invisible");
          assertEquals(foreign.all, 1, "user sees exactly its own row");
          assertEquals(foreign.stamped, 0, "foreign row not updatable");
        },
      );

      // ── 3. Column grants: the route's writes are exactly the granted ones ─
      await t.step(
        "grants: provider UPDATE allowed; email/id UPDATE and INSERT refused (42501)",
        async () => {
          const attempts: Record<string, string> = {};
          for (
            const [name, statement] of [
              [
                "update_email",
                `update public.profiles set email = 'x@example.com' where id = '${a.userId}'`,
              ],
              [
                "update_id",
                `update public.profiles set id = '${
                  uuidFor("pg:steal")
                }' where id = '${a.userId}'`,
              ],
              [
                "insert_profile",
                `insert into public.profiles (id, email) values ('${
                  uuidFor("pg:orphan")
                }', 'o@example.com')`,
              ],
              [
                "credentials_select",
                `select count(*) from public.account_external_credentials`,
              ],
              [
                "credentials_insert",
                `insert into public.account_external_credentials (user_id) values ('${a.userId}')`,
              ],
            ] as const
          ) {
            try {
              await sql.begin(async (tx) => {
                await asUser(tx, a.userId);
                await tx.unsafe(statement);
              });
              attempts[name] = "allowed";
            } catch (error) {
              attempts[name] = sqlError(error).slice(0, 80);
            }
            executed += 1;
          }
          report.grants = attempts;
          for (const [name, outcome] of Object.entries(attempts)) {
            assert(
              outcome.startsWith("42501"),
              `${name}: expected 42501 permission denied, got ${outcome}`,
            );
          }
        },
      );

      // ── 4. Duplicate delivery: N lanes upsert the same user's credential ──
      await t.step(
        `duplicate delivery: ${LANES} concurrent credential upserts for one user → one row, no error`,
        async () => {
          const apple = rows.find((r) => r.provider === "apple") ?? a;
          // Barrier: every lane has its transaction open and role set before
          // any lane issues the upsert, so the ON CONFLICT path is exercised
          // under genuine contention.
          let open!: () => void;
          let ready = 0;
          const gate = new Promise<void>((resolve) => (open = resolve));
          const outcomes = Promise.all(
            Array.from({ length: LANES }, (_, lane) =>
              sql.begin(async (tx) => {
                await asServiceRole(tx);
                ready += 1;
                if (ready === LANES) open();
                await gate;
                const cipher = `v1.lane${lane}.${"x".repeat(40)}`;
                try {
                  await tx.unsafe(
                    `insert into public.account_external_credentials
                       (user_id, apple_refresh_token_encrypted, apple_token_captured_at, apple_revoked_at, updated_at)
                     values ('${apple.userId}', '${cipher}', now(), null, now())
                     on conflict (user_id) do update set
                       apple_refresh_token_encrypted = excluded.apple_refresh_token_encrypted,
                       apple_token_captured_at = excluded.apple_token_captured_at,
                       apple_revoked_at = excluded.apple_revoked_at,
                       updated_at = excluded.updated_at`,
                  );
                  return "ok";
                } catch (error) {
                  return sqlError(error);
                }
              }).catch((error) => sqlError(error))),
          );
          const settled = await outcomes;
          executed += LANES;
          const stored = await sql.unsafe(
            `select count(*)::int as n, min(apple_refresh_token_encrypted) as token from public.account_external_credentials where user_id = '${apple.userId}'`,
          );
          report.duplicateDelivery = {
            outcomes: settled.reduce<Record<string, number>>((acc, o) => {
              acc[o] = (acc[o] ?? 0) + 1;
              return acc;
            }, {}),
            rows: stored[0].n,
            winner: stored[0].token,
          };
          assertEquals(
            settled.filter((o) => o !== "ok"),
            [],
            "no lane errored",
          );
          assertEquals(stored[0].n, 1, "exactly one credential row");
        },
      );

      // ── 5. Constraint: the ciphertext shape the route stores is accepted;
      //      a short/paired-null payload is refused (so a bug there is a 503,
      //      never a silent partial row) ──────────────────────────────────────
      await t.step(
        "constraints: short ciphertext / unpaired captured_at refused",
        async () => {
          const attempts: Record<string, string> = {};
          for (
            const [name, values] of [
              ["short_cipher", `'v1.a.b', now(), null`],
              ["unpaired_capture", `null, now(), null`],
            ] as const
          ) {
            try {
              await sql.begin(async (tx) => {
                await asServiceRole(tx);
                await tx.unsafe(
                  `insert into public.account_external_credentials
                     (user_id, apple_refresh_token_encrypted, apple_token_captured_at, apple_revoked_at, updated_at)
                   values ('${b.userId}', ${values}, now())
                   on conflict (user_id) do update set
                     apple_refresh_token_encrypted = excluded.apple_refresh_token_encrypted,
                     apple_token_captured_at = excluded.apple_token_captured_at`,
                );
              });
              attempts[name] = "allowed";
            } catch (error) {
              attempts[name] = sqlError(error).slice(0, 80);
            }
            executed += 1;
          }
          report.constraints = attempts;
          for (const [name, outcome] of Object.entries(attempts)) {
            assert(
              outcome.startsWith("23514"),
              `${name}: expected 23514 check violation, got ${outcome}`,
            );
          }
        },
      );

      // ── 6. Deletion cascade: auth.users → profile → credential ───────────
      await t.step(
        "cascade: deleting auth.users removes profile + credential",
        async () => {
          const apple = rows.find((r) => r.provider === "apple") ?? a;
          await sql.unsafe(
            `delete from auth.users where id = '${apple.userId}'`,
          );
          const left = await sql.unsafe(
            `select (select count(*) from public.profiles where id = '${apple.userId}')::int as profiles,
                  (select count(*) from public.account_external_credentials where user_id = '${apple.userId}')::int as credentials`,
          );
          executed += 1;
          report.cascade = left[0];
          assertEquals(left[0].profiles, 0);
          assertEquals(left[0].credentials, 0);
        },
      );
    } finally {
      await sql.end();
      report.scenariosExecuted = executed;
      report.findings = findings;
      report.users = rows.length;
      const path = await writeReport("pg", report);
      const lat = report.latencyMs as
        | Record<string, { p50: number; p95: number }>
        | undefined;
      console.log(
        `[stress] pg: ${executed} statements over ${rows.length} users; trigger p50=${
          lat?.trigger.p50.toFixed(2)
        } read p50=${lat?.readProfile.p50.toFixed(2)} p95=${
          lat?.readProfile.p95.toFixed(2)
        } ms → ${path}`,
      );
    }
  },
});
