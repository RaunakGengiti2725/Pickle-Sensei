// Shared plumbing for the Supabase stress harnesses in this directory.
//
// - `pg` is resolved from packages/database (already a workspace dependency),
//   so the harness needs no package.json of its own and stays out of the pnpm
//   workspace graph.
// - `Rng` is a tiny seeded PRNG (sfc32). Every campaign derives one
//   per-iteration seed from (campaign seed, iteration index); the per-iteration
//   seed alone replays that iteration (`STRESS_REPLAY=<seed>`).
// - `asUser` mirrors PostgREST: `set local role authenticated` plus the JWT
//   claims (both the hosted `request.jwt.claims` JSON and the
//   `request.jwt.claim.sub` key the local shim's auth.uid() reads).

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..", "..", "..");
const require = createRequire(path.join(REPO_ROOT, "packages", "database", "package.json"));
export const pg = require("pg");

export const PG_URL = process.env.STRESS_PG_URL ?? "postgres://postgres:x@127.0.0.1:5499/postgres";

export const USERS = {
  a: "00000000-0000-4000-8000-0000000000aa",
  b: "00000000-0000-4000-8000-0000000000bb",
};

/** Deterministic 32-bit PRNG (sfc32) seeded from a 32-bit integer. */
export class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    let s = this.seed;
    this.a = 0x9e3779b9 ^ s;
    this.b = 0x243f6a88 ^ (s << 7) ^ (s >>> 3);
    this.c = 0xb7e15162 ^ ((s * 0x85ebca6b) >>> 0);
    this.d = 1 + (s % 65521);
    for (let i = 0; i < 12; i += 1) this.next();
  }
  next() {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }
  int(min, maxInclusive) {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }
  pick(list) {
    return list[this.int(0, list.length - 1)];
  }
  chance(p) {
    return this.next() < p;
  }
  uuid() {
    const h = () => this.int(0, 0xffff).toString(16).padStart(4, "0");
    return `${h()}${h()}-${h()}-4${h().slice(1)}-${(0x8 + this.int(0, 3)).toString(16)}${h().slice(1)}-${h()}${h()}${h()}`;
  }
}

/** Per-iteration seed: a mixing hash of (campaign seed, index). */
export function iterationSeed(campaignSeed, index) {
  let h = (campaignSeed ^ 0x5bd1e995) >>> 0;
  h = Math.imul(h ^ (index + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  return n;
}

export async function connect() {
  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();
  return client;
}

/** Inside an open transaction: act as PostgREST would for an authenticated user. */
export async function asUser(client, uid) {
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: uid, role: "authenticated", aud: "authenticated" }),
  ]);
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
}

export async function asAnon(client) {
  await client.query("set local role anon");
  await client.query("select set_config('request.jwt.claims', '', true)");
  await client.query("select set_config('request.jwt.claim.sub', '', true)");
}

export async function asServiceRole(client) {
  await client.query("set local role service_role");
  await client.query("select set_config('request.jwt.claims', '', true)");
  await client.query("select set_config('request.jwt.claim.sub', '', true)");
}

/** Seed the two harness users through the real auth trigger path (idempotent). */
export async function seedUsers(client) {
  await client.query(
    `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
       ($1, 'stress-a@example.com', '{"full_name":"Stress A"}', '{"provider":"google"}'),
       ($2, 'stress-b@example.com', '{"full_name":"Stress B"}', '{"provider":"apple"}')
     on conflict (id) do nothing`,
    [USERS.a, USERS.b],
  );
  await client.query(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     select v.provider, v.provider_id, v.user_id::uuid, v.identity_data::jsonb
     from (values
       ('google', 'google-sub-stress-a', $1::text, '{"sub":"google-sub-stress-a"}'),
       ('apple', 'apple-sub-stress-b', $2::text, '{"sub":"apple-sub-stress-b"}')
     ) as v(provider, provider_id, user_id, identity_data)
     where not exists (
       select 1 from auth.identities i where i.provider = v.provider and i.provider_id = v.provider_id
     )`,
    [USERS.a, USERS.b],
  );
  const profiles = await client.query(
    "select count(*)::int as n from public.profiles where id = any($1::uuid[])",
    [[USERS.a, USERS.b]],
  );
  if (profiles.rows[0].n !== 2)
    throw new Error("handle_new_user did not provision both stress profiles");
}

/** The exact sweep SQL pg_cron runs (from cron.job when installed, else the
 *  literal text of migration 20260831000000_scale_and_security.sql). */
export const SWEEP_SQL = {
  "expire-stale-analysis-permits":
    "update public.analysis_permits set status = 'released', outcome = 'expired' where status = 'reserved' and created_at < now() - interval '24 hours'",
  "purge-expired-deletion-requests":
    "delete from public.account_deletion_requests where expires_at < now() - interval '1 day'",
  "purge-old-webhook-events":
    "delete from public.webhook_events where received_at < now() - interval '90 days'",
};

export async function loadSweeps(client) {
  const ext = await client.query("select 1 from pg_extension where extname = 'pg_cron'");
  if (ext.rowCount === 0)
    return { source: "migration-literal", sweeps: { ...SWEEP_SQL }, pgCron: false };
  const jobs = await client.query("select jobname, command from cron.job");
  const sweeps = {};
  for (const row of jobs.rows) sweeps[row.jobname] = row.command;
  for (const name of Object.keys(SWEEP_SQL)) {
    if (!sweeps[name]) throw new Error(`pg_cron installed but job ${name} is not scheduled`);
    if (sweeps[name].trim() !== SWEEP_SQL[name]) {
      throw new Error(
        `cron.job ${name} command drifted from the migration literal:\n${sweeps[name]}`,
      );
    }
  }
  return { source: "cron.job", sweeps, pgCron: true };
}

export function writeJson(dir, name, value) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(value, null, 1));
  return file;
}

/** Normalise a pg error into the fields the reports key on. */
export function describeError(err) {
  return {
    code: err.code ?? null,
    message: String(err.message ?? err).slice(0, 300),
    where: err.where ? String(err.where).slice(0, 200) : null,
    constraint: err.constraint ?? null,
  };
}

/** PostgREST's SQLSTATE → HTTP status mapping (postgrest/src/PostgREST/Error.hs). */
export function postgrestStatus(sqlstate) {
  if (!sqlstate) return 500;
  if (sqlstate === "42501") return 403;
  if (sqlstate === "42883" || sqlstate === "42P01") return 404;
  if (sqlstate === "23503" || sqlstate === "23505") return 409;
  if (sqlstate === "25006") return 405;
  if (sqlstate === "P0001") return 400;
  const cls = sqlstate.slice(0, 2);
  if (cls === "08" || cls === "53") return 503;
  if (
    ["09", "25", "2D", "38", "39", "3B", "40", "54", "55", "57", "58", "F0", "HV", "XX"].includes(
      cls,
    )
  )
    return 500;
  if (cls === "0L" || cls === "0P" || cls === "28") return 403;
  if (cls === "P0") return 500;
  return 400;
}
