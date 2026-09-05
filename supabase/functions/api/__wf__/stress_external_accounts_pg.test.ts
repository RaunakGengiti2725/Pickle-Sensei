// Stress lens `failure-load` for externalAccounts.ts — REAL POSTGRES half.
//
// The route matrix and load campaigns model PostgREST in memory. This file
// replays the EXACT write shapes the edge function issues against
// public.account_external_credentials (bootstrap upsert, Apple-revocation
// checkpoint, permanent-clear, RevenueCat checkpoint upsert, auth.users
// cascade) on a disposable postgres:16 with shim_auth.sql + every migration
// applied (./xc_pg_up.sh), using real AES-GCM ciphertext from
// externalAccounts.ts, seeded users, N concurrent connections for the
// duplicate-delivery cases, and the free-rating identity ledger across the
// deletion cascade (double-spend is P0 if it breaks).
//
// PostgREST is not in the loop: an upsert with `resolution=merge-duplicates`
// is replayed as INSERT … ON CONFLICT (user_id) DO UPDATE SET <every payload
// column>, which is what PostgREST emits for that header.
//
//   XC_PG_CONTAINER=pickle-stress-pg XC_PG_PORT=55434 ./xc_pg_up.sh
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55434/postgres STRESS_PG_USERS=200 \
//     deno test -A --no-check --config deno.json stress_external_accounts_pg.test.ts
//
// Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { Prng } from "./xc_concurrency_harness.ts";
import { decryptAppleRefreshToken, encryptAppleRefreshToken } from "../externalAccounts.ts";
import { BASE_SEED, round, seedFor, writeReport } from "./stress_external_accounts_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const PG_USERS = Math.max(3, Number(Deno.env.get("STRESS_PG_USERS") ?? "12"));
const LANES = Math.max(2, Number(Deno.env.get("STRESS_PG_LANES") ?? "8"));
const TABLE = "public.account_external_credentials";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

interface CredRow {
  user_id: string;
  apple_refresh_token_encrypted: string | null;
  apple_token_captured_at: Date | null;
  apple_revoked_at: Date | null;
  revenuecat_deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const KEY = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));

function connect(): Sql {
  return postgres(PG_URL, { max: LANES + 4, onnotice: () => {} });
}

async function createUser(sql: Sql, userId: string, provider: "apple" | "google", sub: string) {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"${provider}"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('${provider}', '${sub}', '${userId}', '{"sub":"${sub}"}')`,
  );
}

async function readRow(sql: Sql, userId: string): Promise<CredRow | null> {
  const rows = await sql.unsafe(`select * from ${TABLE} where user_id = '${userId}'`);
  return (rows[0] as unknown as CredRow) ?? null;
}

/** PostgREST `upsert(payload, {onConflict:"user_id"})` (merge-duplicates). */
async function pgrstUpsert(sql: Sql | Tx, payload: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(payload);
  const values = cols.map((_, i) => `$${i + 1}`).join(", ");
  const sets = cols.filter((c) => c !== "user_id").map((c) => `${c} = excluded.${c}`).join(", ");
  await sql.unsafe(
    `insert into ${TABLE} (${cols.join(", ")}) values (${values}) on conflict (user_id) do update set ${sets}`,
    cols.map((c) => payload[c] as never),
  );
}

/** PostgREST `.update(patch).eq("user_id", id)`. */
async function pgrstUpdate(sql: Sql | Tx, userId: string, patch: Record<string, unknown>): Promise<number> {
  const cols = Object.keys(patch);
  const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
  const r = await sql.unsafe(`update ${TABLE} set ${sets} where user_id = $${cols.length + 1}`, [
    ...cols.map((c) => patch[c] as never),
    userId as never,
  ]);
  return r.count;
}

function sqlstate(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : String(error);
}

async function expectSqlState(fn: () => Promise<unknown>, code: string, what: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assertEquals(sqlstate(error), code, `${what}: SQLSTATE`);
    return;
  }
  throw new Error(`${what}: expected SQLSTATE ${code}, statement succeeded`);
}

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

interface Outcome {
  scenario: string;
  seed: number;
  user: string;
  verdict: "HELD" | "BROKEN";
  detail: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// PG-EA1 — the edge function's credential-row lifecycle, one seeded user at a time
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress/externalAccounts pg: EA1 credential-row lifecycle (bootstrap upsert → re-bootstrap → revoke checkpoint → RC checkpoint → permanent clear → cascade) with real ciphertext",
  ignore,
  async fn() {
    const sql = connect();
    const outcomes: Outcome[] = [];
    const latencies: Record<string, number[]> = {};
    const time = async <T>(op: string, fn: () => Promise<T>): Promise<T> => {
      const t0 = performance.now();
      const out = await fn();
      (latencies[op] ??= []).push(round(performance.now() - t0, 2));
      return out;
    };
    try {
      for (let i = 0; i < PG_USERS; i += 1) {
        const seed = seedFor("pg.lifecycle", i);
        const rng = new Prng(seed);
        const uid = rng.uuid();
        const sub = `apple-${rng.uuid()}`;
        const problems: string[] = [];
        await createUser(sql, uid, "apple", sub);

        // 1. bootstrap upsert (index.ts ~3233): real ciphertext of a token 32..512 chars
        const token1 = `rt_${"x".repeat(rng.int(29, 509))}`;
        const enc1 = await encryptAppleRefreshToken(token1, uid, KEY);
        const now1 = new Date().toISOString();
        await time("bootstrap_upsert", () =>
          pgrstUpsert(sql, {
            user_id: uid,
            apple_refresh_token_encrypted: enc1,
            apple_token_captured_at: now1,
            apple_revoked_at: null,
            updated_at: now1,
          }));
        let row = await readRow(sql, uid);
        if (!row) problems.push("bootstrap upsert stored no row");
        else {
          const back = await decryptAppleRefreshToken(row.apple_refresh_token_encrypted ?? "", uid, KEY);
          if (back !== token1) problems.push("stored ciphertext does not decrypt to the token");
          if (!row.apple_token_captured_at) problems.push("captured_at missing after bootstrap");
        }

        // 2. RC checkpoint upsert (index.ts ~3014) must MERGE — token survives
        const now2 = new Date().toISOString();
        await time("rc_checkpoint_upsert", () =>
          pgrstUpsert(sql, { user_id: uid, revenuecat_deleted_at: now2, updated_at: now2 }));
        row = await readRow(sql, uid);
        if (row?.apple_refresh_token_encrypted !== enc1) problems.push("RC checkpoint upsert clobbered the Apple token");
        if (!row?.revenuecat_deleted_at) problems.push("RC checkpoint not stored");

        // 3. re-bootstrap (second sign-in) with a NEW token — resets apple_revoked_at only
        await time("revoke_checkpoint_update", () =>
          pgrstUpdate(sql, uid, { apple_revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() }));
        const token2 = `rt_${"y".repeat(rng.int(29, 509))}`;
        const enc2 = await encryptAppleRefreshToken(token2, uid, KEY);
        const now3 = new Date().toISOString();
        await time("bootstrap_upsert", () =>
          pgrstUpsert(sql, {
            user_id: uid,
            apple_refresh_token_encrypted: enc2,
            apple_token_captured_at: now3,
            apple_revoked_at: null,
            updated_at: now3,
          }));
        row = await readRow(sql, uid);
        if (row?.apple_refresh_token_encrypted !== enc2) problems.push("re-bootstrap did not replace the token");
        if (row?.apple_revoked_at !== null) problems.push("re-bootstrap did not reset apple_revoked_at");
        const rcSurvivesRebootstrap = row?.revenuecat_deleted_at !== null;

        // 4. permanent clear (index.ts ~2981): both columns null together — accepted
        await time("permanent_clear_update", () =>
          pgrstUpdate(sql, uid, {
            apple_refresh_token_encrypted: null,
            apple_token_captured_at: null,
            updated_at: new Date().toISOString(),
          }));
        row = await readRow(sql, uid);
        if (row?.apple_refresh_token_encrypted !== null || row?.apple_token_captured_at !== null) {
          problems.push("permanent clear left a half-cleared row");
        }

        // 5. a half clear (token only) must be refused by the capture-pair constraint
        await pgrstUpsert(sql, {
          user_id: uid,
          apple_refresh_token_encrypted: enc2,
          apple_token_captured_at: now3,
          apple_revoked_at: null,
          updated_at: now3,
        });
        try {
          await expectSqlState(
            () => pgrstUpdate(sql, uid, { apple_refresh_token_encrypted: null }),
            "23514",
            "token-only clear",
          );
          await expectSqlState(
            () => pgrstUpdate(sql, uid, { apple_token_captured_at: null }),
            "23514",
            "captured_at-only clear",
          );
        } catch (error) {
          problems.push(String(error));
        }

        // 6. checkpoint for a user with no profile → FK refusal (edge maps to 503)
        try {
          await expectSqlState(
            () => pgrstUpsert(sql, { user_id: rng.uuid(), revenuecat_deleted_at: now2, updated_at: now2 }),
            "23503",
            "orphan RC checkpoint",
          );
        } catch (error) {
          problems.push(String(error));
        }

        // 7. auth.admin.deleteUser → auth.users delete → profile → credential row cascade
        await time("auth_user_delete_cascade", () => sql.unsafe(`delete from auth.users where id = '${uid}'`));
        row = await readRow(sql, uid);
        if (row) problems.push("credential row survived the auth.users cascade");

        outcomes.push({
          scenario: "EA1",
          seed,
          user: uid,
          verdict: problems.length ? "BROKEN" : "HELD",
          detail: problems.length
            ? problems.join("; ")
            : `lifecycle ok; revenuecat_deleted_at survives re-bootstrap=${rcSurvivesRebootstrap}`,
        });
        assert(rcSurvivesRebootstrap, "schema-level confirmation of the R24 observation: re-bootstrap does not reset revenuecat_deleted_at");
      }
    } finally {
      await sql.end();
    }
    const summary = Object.fromEntries(
      Object.entries(latencies).map(([op, ms]) => {
        const sorted = [...ms].sort((a, b) => a - b);
        return [op, { n: ms.length, p50_ms: sorted[Math.floor(sorted.length / 2)], max_ms: sorted[sorted.length - 1] }];
      }),
    );
    const path = await writeReport("pg_lifecycle", { baseSeed: BASE_SEED, users: PG_USERS, latency: summary, outcomes });
    const broken = outcomes.filter((o) => o.verdict === "BROKEN");
    console.log(`[stress pg/EA1] ${PG_USERS} users × 7 steps, ${broken.length} BROKEN → ${path}`);
    assertEquals(broken, []);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PG-EA2 — ciphertext size boundary of account_external_credentials_apple_token_size
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress/externalAccounts pg: EA2 ciphertext size boundary — find the refresh-token length at which the 8192 check refuses the bootstrap upsert",
  ignore,
  async fn() {
    const sql = connect();
    try {
      const rng = new Prng(seedFor("pg.size", 0));
      const uid = rng.uuid();
      await createUser(sql, uid, "apple", `apple-${rng.uuid()}`);
      const probe = async (tokenLength: number): Promise<{ cipherLength: number; accepted: boolean; code?: string }> => {
        const enc = await encryptAppleRefreshToken("t".repeat(tokenLength), uid, KEY);
        const now = new Date().toISOString();
        try {
          await pgrstUpsert(sql, {
            user_id: uid,
            apple_refresh_token_encrypted: enc,
            apple_token_captured_at: now,
            apple_revoked_at: null,
            updated_at: now,
          });
          return { cipherLength: enc.length, accepted: true };
        } catch (error) {
          return { cipherLength: enc.length, accepted: false, code: sqlstate(error) };
        }
      };
      // Realistic Apple refresh tokens (observed ~64-ish chars) and generous headroom.
      const realistic = [1, 16, 64, 128, 512, 2048, 4096];
      const table: Array<{ tokenLength: number; cipherLength: number; accepted: boolean; code?: string }> = [];
      for (const n of realistic) table.push({ tokenLength: n, ...(await probe(n)) });
      // Binary search the first refused length.
      let lo = 4096, hi = 8192;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        const r = await probe(mid);
        if (r.accepted) lo = mid;
        else hi = mid;
      }
      const lastAccepted = { tokenLength: lo, ...(await probe(lo)) };
      const firstRefused = { tokenLength: hi, ...(await probe(hi)) };
      table.push(lastAccepted, firstRefused);
      // A short ciphertext (<20) — never produced by the edge fn — is refused.
      let short: string;
      try {
        await pgrstUpsert(sql, {
          user_id: uid,
          apple_refresh_token_encrypted: "v1.short.x",
          apple_token_captured_at: new Date().toISOString(),
          apple_revoked_at: null,
          updated_at: new Date().toISOString(),
        });
        short = "accepted";
      } catch (error) {
        short = sqlstate(error);
      }
      await sql.unsafe(`delete from auth.users where id = '${uid}'`);
      const path = await writeReport("pg_ciphertext_size_boundary", { table, shortCiphertext: short });
      console.log(`[stress pg/EA2] realistic lengths accepted=${table.slice(0, realistic.length).every((r) => r.accepted)}; last accepted token length=${lo} (cipher ${lastAccepted.cipherLength}), first refused=${hi} (${firstRefused.code}); short ciphertext → ${short} → ${path}`);
      assert(table.slice(0, realistic.length).every((r) => r.accepted), "every realistic token length is storable");
      assertEquals(firstRefused.code, "23514");
      assertEquals(short, "23514");
    } finally {
      await sql.end();
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PG-EA3 — duplicate delivery: N concurrent checkpoint writers on ONE row
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress/externalAccounts pg: EA3 duplicate delivery — N concurrent RC-checkpoint upserts + revoke updates + a bootstrap upsert on the same row commit without deadlock, one row remains, token intact",
  ignore,
  async fn() {
    const sql = connect();
    const outcomes: Outcome[] = [];
    try {
      for (let i = 0; i < Math.min(PG_USERS, 25); i += 1) {
        const seed = seedFor("pg.dup", i);
        const rng = new Prng(seed);
        const uid = rng.uuid();
        await createUser(sql, uid, "apple", `apple-${rng.uuid()}`);
        const enc = await encryptAppleRefreshToken(`rt_${rng.uuid()}`, uid, KEY);
        const now = new Date().toISOString();
        await pgrstUpsert(sql, {
          user_id: uid,
          apple_refresh_token_encrypted: enc,
          apple_token_captured_at: now,
          apple_revoked_at: null,
          updated_at: now,
        });
        const b = barrier();
        let ready = 0;
        const results: string[] = [];
        const lanes = Array.from({ length: LANES }, (_, lane) =>
          sql
            .begin(async (tx) => {
              ready += 1;
              await b.gate;
              const t = tx as unknown as Tx;
              const ts = new Date().toISOString();
              switch (lane % 3) {
                case 0:
                  await pgrstUpsert(t, { user_id: uid, revenuecat_deleted_at: ts, updated_at: ts });
                  return "rc_checkpoint";
                case 1:
                  await pgrstUpdate(t, uid, { apple_revoked_at: ts, updated_at: ts });
                  return "revoke_checkpoint";
                default:
                  await pgrstUpsert(t, {
                    user_id: uid,
                    apple_refresh_token_encrypted: enc,
                    apple_token_captured_at: ts,
                    apple_revoked_at: null,
                    updated_at: ts,
                  });
                  return "bootstrap_upsert";
              }
            })
            .then((r) => results.push(`${r}:ok`), (e) => results.push(`${sqlstate(e)}`)));
        while (ready < LANES) await new Promise((r) => setTimeout(r, 1));
        b.open();
        await Promise.all(lanes);
        const rows = await sql.unsafe(`select count(*)::int as n from ${TABLE} where user_id = '${uid}'`);
        const row = await readRow(sql, uid);
        const failures = results.filter((r) => !r.endsWith(":ok"));
        const problems: string[] = [];
        if (failures.length) problems.push(`lanes failed: ${failures.join(",")}`);
        if (rows[0].n !== 1) problems.push(`row count ${rows[0].n}`);
        if (row?.apple_refresh_token_encrypted !== enc) problems.push("token changed under concurrent checkpoints");
        if (!row?.revenuecat_deleted_at) problems.push("RC checkpoint lost");
        outcomes.push({
          scenario: "EA3",
          seed,
          user: uid,
          verdict: problems.length ? "BROKEN" : "HELD",
          detail: problems.length ? problems.join("; ") : `${LANES} lanes committed: ${results.join(" ")}`,
        });
        await sql.unsafe(`delete from auth.users where id = '${uid}'`);
      }
    } finally {
      await sql.end();
    }
    const path = await writeReport("pg_duplicate_delivery", { baseSeed: BASE_SEED, lanes: LANES, outcomes });
    const broken = outcomes.filter((o) => o.verdict === "BROKEN");
    console.log(`[stress pg/EA3] ${outcomes.length} bursts × ${LANES} lanes, ${broken.length} BROKEN → ${path}`);
    assertEquals(broken, []);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PG-EA4 — free-rating double-spend across the deletion cascade the edge fn
//          relies on (auth.admin.deleteUser → cascade) — P0 if broken
// ─────────────────────────────────────────────────────────────────────────────

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

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function spendOne(tx: Tx, key: string, shotId: string): Promise<string> {
  const p = await tx.unsafe(`select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`);
  if (String(p[0].result) !== "accepted") return `reserve:${p[0].result}`;
  const shot = {
    id: shotId,
    analysisPermitId: String(p[0].permit_id),
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
  };
  const a = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as result`, [JSON.stringify(shot)]);
  return `apply:${a[0].result}`;
}

Deno.test({
  name: "stress/externalAccounts pg: EA4 free-rating ledger survives the account-deletion cascade — spend 2, deleteUser, re-bootstrap the same Apple subject → lifetime_scored_count()=2, reserve paywalled (double-spend = P0)",
  ignore,
  async fn() {
    const sql = connect();
    const outcomes: Outcome[] = [];
    try {
      for (let i = 0; i < PG_USERS; i += 1) {
        const seed = seedFor("pg.ledger", i);
        const rng = new Prng(seed);
        const sub = `apple-sub-${rng.uuid()}`;
        const oldUid = rng.uuid();
        await sql.unsafe(`delete from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('apple', '${sub}')`);
        await createUser(sql, oldUid, "apple", sub);
        const spends: string[] = [];
        await sql.begin(async (tx) => {
          const t = tx as unknown as Tx;
          await asUser(t, oldUid);
          for (let k = 0; k < 2; k += 1) spends.push(await spendOne(t, `spend-${i}-${k}`, rng.uuid()));
        });
        // The edge fn's deletion: external cleanup, then auth.admin.deleteUser → cascade.
        await sql.unsafe(`delete from auth.users where id = '${oldUid}'`);
        const ledgerAfterDelete = await sql.unsafe(
          `select scored_count::int as n from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('apple', '${sub}')`,
        );
        // Re-bootstrap: Supabase Auth creates a NEW auth.users row for the same Apple subject.
        const newUid = rng.uuid();
        await createUser(sql, newUid, "apple", sub);
        let lifetime = -1;
        let reserve = "";
        await sql.begin(async (tx) => {
          const t = tx as unknown as Tx;
          await asUser(t, newUid);
          lifetime = Number((await t.unsafe(`select public.lifetime_scored_count()::int as n`))[0].n);
          reserve = String((await t.unsafe(`select x.result from public.reserve_analysis_permit('after-${i}') x`))[0].result);
        });
        const problems: string[] = [];
        if (spends.join() !== "apply:accepted,apply:accepted") problems.push(`setup spends: ${spends.join()}`);
        if (Number(ledgerAfterDelete[0]?.n) !== 2) problems.push(`ledger after delete = ${ledgerAfterDelete[0]?.n ?? "missing"}`);
        if (lifetime !== 2) problems.push(`recreated account lifetime_scored_count()=${lifetime} (expected 2 — free ratings RESET = double spend)`);
        if (reserve !== "access.paywall_required") problems.push(`recreated account reserve → ${reserve} (expected access.paywall_required)`);
        outcomes.push({
          scenario: "EA4",
          seed,
          user: `${oldUid}→${newUid}`,
          verdict: problems.length ? "BROKEN" : "HELD",
          detail: problems.length ? problems.join("; ") : `ledger=2 after cascade, lifetime=2, reserve=${reserve}`,
        });
        await sql.unsafe(`delete from auth.users where id = '${newUid}'`);
      }
    } finally {
      await sql.end();
    }
    const path = await writeReport("pg_free_rating_ledger_cascade", { baseSeed: BASE_SEED, users: PG_USERS, outcomes });
    const broken = outcomes.filter((o) => o.verdict === "BROKEN");
    console.log(`[stress pg/EA4] ${outcomes.length} delete→re-bootstrap cycles, ${broken.length} BROKEN → ${path}`);
    assertEquals(broken, []);
  },
});
