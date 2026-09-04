#!/usr/bin/env node
// ============================================================================
// STRESS — public.user_saved_drills + its grants, BOUNDARY / MALFORMED INPUT.
//
// Drives the saved-drill bookmark surface of the schema the way a hostile (or
// merely buggy) authenticated client can: it holds SELECT/INSERT/UPDATE/DELETE
// on the table (20260829140000_permits_sync_consent.sql), so every column of
// every row it owns is a client-controlled input, not just the `slug` the Edge
// Function chooses to send.
//
// Every iteration is derived from a string seed, runs in its own transaction
// (rolled back, so workers never collide and the campaign is idempotent), and
// is classified:
//
//   HELD   the input was rejected with a TYPED SQLSTATE and nothing persisted,
//          or it was accepted AND every table invariant still holds.
//   BROKEN an untyped/internal error (XX000, connection loss), or an accepted
//          write that violates an invariant:
//            i1  slug matches ^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$
//            i2  the persisted row belongs to the calling auth.uid()
//            i3  saved_at is finite and inside the [2000, 2100) window every
//                other client-writable timestamp in this schema is held to
//                (shots/captures captured_at, 20260904000000)
//            i4  saved_at round-trips through JSON as a value Date.parse()
//                accepts — the mobile client rejects the WHOLE saved list
//                otherwise (apps/mobile/src/training/api.ts parseSavedDrill)
//
// Usage:
//   node supabase/tests/stress/db_drills_saved_boundary.mjs            # smoke
//   STRESS_ITER=3200 node supabase/tests/stress/db_drills_saved_boundary.mjs
//
// Env: STRESS_PG_URL (default postgres://postgres:x@127.0.0.1:5499/postgres,
// see setup_db.sh), STRESS_ITER (default 240), STRESS_WORKERS (default 6),
// STRESS_SEED (campaign prefix, default "drills-saved-boundary"),
// STRESS_OUT (JSON results table path).
//
// Exit 0 = no BROKEN iteration. Exit 1 = at least one (the JSON table and the
// stderr summary name every failing seed). Exit 2 = harness/setup failure —
// never a pass.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { loadPg } from "./lib/pg.mjs";
import { rngFor } from "./lib/rng.mjs";

const PG_URL = process.env.STRESS_PG_URL ?? "postgres://postgres:x@127.0.0.1:5499/postgres";
const ITERATIONS = Number(process.env.STRESS_ITER ?? 240);
const WORKERS = Number(process.env.STRESS_WORKERS ?? 6);
const CAMPAIGN = process.env.STRESS_SEED ?? "drills-saved-boundary";
const OUT = process.env.STRESS_OUT ?? "";
const REPLAY = (process.env.STRESS_REPLAY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const REPLAY_TIMES = Number(process.env.STRESS_REPLAY_TIMES ?? 1);

const ALICE = "00000000-0000-4000-8000-0000000da11c";
const BOB = "00000000-0000-4000-8000-0000000db0b0";

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

// SQLSTATEs that count as a graceful, typed rejection at this boundary.
const TYPED_REJECTIONS = new Set([
  "22001", // string_data_right_truncation
  "22007", // invalid_datetime_format
  "22008", // datetime_field_overflow
  "22021", // character_not_in_repertoire (null byte / bad UTF-8)
  "22023", // invalid_parameter_value
  "22P02", // invalid_text_representation (bad uuid / bad jsonb / bad timestamp)
  "22P05", // untranslatable_character
  "23502", // not_null_violation
  "23503", // foreign_key_violation
  "23505", // unique_violation
  "23514", // check_violation
  "42501", // insufficient_privilege (RLS / missing grant)
  "42601", // syntax_error — only reachable if the harness itself builds bad SQL
  "54000", // program_limit_exceeded
]);

// ── input generators ────────────────────────────────────────────────────────
// Each returns { category, value } where value is bound as a parameter (never
// interpolated), so a "malformed" input exercises the DB's own coercion and
// constraint layer rather than the harness' string building.

const NORMALIZATION_PAIRS = [
  ["dink\u00e9", "dink\u0065\u0301"], // é precomposed vs combining
  ["a\uFF10", "a0"], // fullwidth digit vs ASCII
  ["\u1E9B\u0323", "\u1E69"], // NFKD vs NFC of ẛ̣
];

const TRAVERSALS = [
  "../../../etc/passwd",
  "..%2f..%2fetc%2fpasswd",
  "drills/../../secret",
  "/absolute/slug",
  "C:\\Windows\\system32",
  "dink-ladder/../dink-ladder",
  "%2e%2e%2f",
  "....//....//etc",
];

const PROTO_KEYS = ["__proto__", "constructor", "prototype", "__defineGetter__", "toString"];

const MALFORMED_JSON = [
  '{"slug":"dink-ladder"', // truncated
  '{"slug":}',
  "{slug:'dink'}",
  "[",
  "null",
  "true",
  '"dink-ladder"',
  '{"slug":"dink-ladder","slug":"other"}', // duplicate key
  '{"slug":{"$ne":null}}',
  '{"__proto__":{"admin":true},"slug":"dink"}',
  '{"slug":"dink","schemaVersion":99999999999999999999}',
  "",
  " ",
  '{"slug":"\\ud800"}', // lone surrogate
];

const NUMERIC_EDGES = [
  "NaN",
  "Infinity",
  "-Infinity",
  "infinity",
  "-infinity",
  "-0",
  "0",
  "1e309",
  "9223372036854775808",
  "-9223372036854775809",
  "1.7976931348623157e309",
];

function slugGenerators(rng) {
  const generators = [
    () => ({ category: "valid-slug", value: rng.pick(["dink-ladder", "third_shot_drop", "A1"]) }),
    () => ({ category: "empty", value: "" }),
    () => ({ category: "whitespace", value: rng.pick([" ", "\t", "\n", " dink ", "dink\r\n"]) }),
    () => ({ category: "boundary-length-120", value: "a".repeat(120) }),
    () => ({ category: "boundary-length-121", value: "a".repeat(121) }),
    () => ({ category: "huge-string", value: "a".repeat(64 * 1024 + rng.int(4096)) }),
    () => ({ category: "huge-string-1mb", value: "b".repeat(1024 * 1024) }),
    () => ({ category: "null-byte", value: `dink${"\u0000"}ladder` }),
    () => ({ category: "path-traversal", value: rng.pick(TRAVERSALS) }),
    () => ({
      category: "sql-metachar",
      value: rng.pick(["dink';--", "a' or 1=1 --", 'a";', "a\\"]),
    }),
    () => ({ category: "regex-metachar", value: rng.pick(["^dink$", ".*", "a|b", "[a-z]", "a%"]) }),
    () => ({ category: "leading-punct", value: rng.pick(["-dink", "_dink", ".dink"]) }),
    () => ({ category: "unicode-normalization", value: rng.pick(rng.pick(NORMALIZATION_PAIRS)) }),
    () => ({ category: "emoji-grapheme", value: rng.pick(["🥒", "a👍🏽b", "🏳️‍🌈".repeat(30)]) }),
    () => ({ category: "rtl-bidi", value: rng.pick(["dink\u202Eladder", "\u200Bdink"]) }),
    () => ({ category: "homoglyph", value: rng.pick(["dіnk-ladder", "ｄｉｎｋ"]) }),
    () => ({ category: "prototype-key", value: rng.pick(PROTO_KEYS) }),
    () => ({ category: "numeric-edge", value: rng.pick(NUMERIC_EDGES) }),
    () => ({ category: "newline-anchor-bypass", value: rng.pick(["dink\n../etc", "ok\n\u0000"]) }),
    () => ({ category: "case-mixed", value: rng.pick(["DINK-LADDER", "DiNk_1"]) }),
  ];
  return rng.pick(generators)();
}

function timestampGenerators(rng) {
  const generators = [
    () => ({ category: "ts-now", value: new Date().toISOString() }),
    () => ({ category: "ts-infinity", value: "infinity" }),
    () => ({ category: "ts-neg-infinity", value: "-infinity" }),
    () => ({ category: "ts-max-year", value: "294276-01-01T00:00:00Z" }),
    () => ({ category: "ts-min-year", value: "4714-11-24 BC" }),
    () => ({ category: "ts-year-9999", value: "9999-12-31T23:59:59Z" }),
    () => ({ category: "ts-epoch", value: "epoch" }),
    () => ({ category: "ts-keyword", value: rng.pick(["now", "today", "allballs", "yesterday"]) }),
    () => ({ category: "ts-nan", value: "NaN" }),
    () => ({
      category: "ts-malformed",
      value: rng.pick(["not-a-date", "2026-13-45T99:99:99Z", ""]),
    }),
    () => ({ category: "ts-huge", value: `2026-01-01T00:00:00${"0".repeat(4096)}Z` }),
    () => ({ category: "ts-null-byte", value: `2026-01-01T00:00:00Z${"\u0000"}` }),
  ];
  return rng.pick(generators)();
}

function principalGenerators(rng) {
  const generators = [
    () => ({ category: "sub-alice", value: ALICE }),
    () => ({ category: "sub-empty", value: "" }),
    () => ({ category: "sub-not-uuid", value: "not-a-uuid" }),
    () => ({ category: "sub-uuid-ish", value: "00000000-0000-4000-8000-00000000000z" }),
    () => ({ category: "sub-huge", value: "a".repeat(64 * 1024) }),
    () => ({ category: "sub-null-byte", value: `${ALICE}\u0000` }),
    () => ({ category: "sub-unknown-user", value: "11111111-1111-4111-8111-111111111111" }),
    () => ({ category: "sub-json-injection", value: '{"sub":"' + ALICE + '"}' }),
    () => ({ category: "sub-whitespace-padded", value: `  ${ALICE}  ` }),
  ];
  return rng.pick(generators)();
}

// ── operations ──────────────────────────────────────────────────────────────
// Every op runs as `authenticated` with a JWT sub, inside a transaction that
// is always rolled back. `probe` returns the rows the DB actually persisted so
// the invariants are asserted against storage, not against the statement.

const OPS = [
  "insert",
  "insert-with-saved-at",
  "upsert-do-nothing",
  "update-slug",
  "update-saved-at",
  "delete",
  "select-eq",
  "cross-user-insert",
  "cross-user-update",
  "anon-insert",
  "json-body-slug",
  "malformed-principal",
];

async function runIteration(client, seed) {
  const rng = rngFor(seed);
  const op = rng.pick(OPS);
  const slug = slugGenerators(rng);
  const ts = timestampGenerators(rng);
  const principal =
    op === "malformed-principal"
      ? principalGenerators(rng)
      : { category: "sub-alice", value: ALICE };
  const jsonBody = rng.pick(MALFORMED_JSON);

  const record = {
    seed,
    op,
    slugCategory: slug.category,
    tsCategory: ts.category,
    principalCategory: principal.category,
    inputBytes: Buffer.byteLength(slug.value, "utf8"),
    outcome: "unknown",
    sqlstate: null,
    verdict: "HELD",
    violations: [],
    persisted: null,
  };

  await client.query("begin");
  try {
    if (op === "anon-insert") {
      await client.query("set local role anon");
    } else {
      await client.query("set local role authenticated");
    }
    // Hosted GoTrue sets both; the shim's auth.uid() reads claim.sub.
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [principal.value]);
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({
        sub: principal.value,
        role: op === "anon-insert" ? "anon" : "authenticated",
      }),
    ]);

    switch (op) {
      case "insert":
      case "malformed-principal":
        await client.query(
          "insert into public.user_saved_drills (user_id, slug) values (auth.uid(), $1)",
          [slug.value],
        );
        break;
      case "insert-with-saved-at":
        await client.query(
          "insert into public.user_saved_drills (user_id, slug, saved_at) values (auth.uid(), $1, $2)",
          [slug.value, ts.value],
        );
        break;
      case "upsert-do-nothing":
        await client.query(
          "insert into public.user_saved_drills (user_id, slug) values (auth.uid(), $1) on conflict (user_id, slug) do nothing",
          [slug.value],
        );
        await client.query(
          "insert into public.user_saved_drills (user_id, slug) values (auth.uid(), $1) on conflict (user_id, slug) do nothing",
          [slug.value],
        );
        break;
      case "update-slug":
        await client.query(
          "insert into public.user_saved_drills (user_id, slug) values (auth.uid(), 'seed-row')",
        );
        await client.query(
          "update public.user_saved_drills set slug = $1 where slug = 'seed-row'",
          [slug.value],
        );
        break;
      case "update-saved-at":
        await client.query(
          "insert into public.user_saved_drills (user_id, slug) values (auth.uid(), 'seed-row')",
        );
        await client.query(
          "update public.user_saved_drills set saved_at = $1 where slug = 'seed-row'",
          [ts.value],
        );
        break;
      case "delete":
        await client.query(
          "insert into public.user_saved_drills (user_id, slug) values (auth.uid(), 'seed-row')",
        );
        await client.query("delete from public.user_saved_drills where slug = $1", [slug.value]);
        break;
      case "select-eq":
        await client.query("select slug, saved_at from public.user_saved_drills where slug = $1", [
          slug.value,
        ]);
        break;
      case "cross-user-insert":
        await client.query("insert into public.user_saved_drills (user_id, slug) values ($1, $2)", [
          BOB,
          slug.value,
        ]);
        break;
      case "cross-user-update":
        await client.query("update public.user_saved_drills set slug = $1 where user_id = $2", [
          slug.value,
          BOB,
        ]);
        break;
      case "anon-insert":
        await client.query("insert into public.user_saved_drills (user_id, slug) values ($1, $2)", [
          ALICE,
          slug.value,
        ]);
        break;
      case "json-body-slug":
        // The Edge Function derives the slug from a JSON body; model that at
        // the DB boundary so malformed/truncated JSON is a real input class.
        await client.query(
          "insert into public.user_saved_drills (user_id, slug) values (auth.uid(), ($1::jsonb ->> 'slug'))",
          [jsonBody],
        );
        break;
      default:
        throw new Error(`unknown op ${op}`);
    }
    record.outcome = "accepted";
    record.persisted = await probe(client);
    record.violations = invariantViolations(record.persisted, principal.value);
  } catch (error) {
    record.outcome = "rejected";
    record.sqlstate = error.code ?? null;
    record.message = String(error.message ?? "").slice(0, 200);
    if (!record.sqlstate || !TYPED_REJECTIONS.has(record.sqlstate)) {
      record.violations.push(`untyped-error:${record.sqlstate ?? "none"}`);
    }
  } finally {
    try {
      await client.query("rollback");
    } catch {
      // A dead connection is itself a finding; surfaced by the untyped check.
      record.violations.push("rollback-failed");
    }
  }
  if (record.violations.length > 0) record.verdict = "BROKEN";
  return record;
}

async function probe(client) {
  const rows = await client.query(
    `select user_id::text as user_id,
            slug,
            saved_at::text as saved_at_text,
            to_jsonb(saved_at) #>> '{}' as saved_at_json,
            saved_at > '2000-01-01'::timestamptz and saved_at < '2100-01-01'::timestamptz as in_window
       from public.user_saved_drills`,
  );
  return rows.rows;
}

function invariantViolations(rows, expectedOwner) {
  const violations = [];
  for (const row of rows) {
    if (!SLUG_RE.test(row.slug)) {
      violations.push(`i1-slug-shape:${JSON.stringify(row.slug.slice(0, 40))}`);
    }
    if (row.user_id !== expectedOwner) {
      violations.push(`i2-owner:${row.user_id}`);
    }
    if (row.in_window !== true) {
      violations.push(`i3-saved-at-window:${row.saved_at_text}`);
    }
    if (Number.isNaN(Date.parse(row.saved_at_json))) {
      violations.push(`i4-saved-at-unparseable:${row.saved_at_json}`);
    }
  }
  return violations;
}

// ── setup / driver ──────────────────────────────────────────────────────────

async function ensureUsers(client) {
  await client.query(
    `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
     values ($1, 'stress-alice@example.com', '{"full_name":"Stress Alice"}', '{"provider":"google"}'),
            ($2, 'stress-bob@example.com', '{"full_name":"Stress Bob"}', '{"provider":"apple"}')
     on conflict (id) do nothing`,
    [ALICE, BOB],
  );
  await client.query(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', 'stress-google-alice', $1, '{"sub":"stress-google-alice"}'),
            ('apple', 'stress-apple-bob', $2, '{"sub":"stress-apple-bob"}')
     on conflict (provider_id, provider) do nothing`,
    [ALICE, BOB],
  );
  const check = await client.query(
    "select count(*)::int as n from public.profiles where id in ($1, $2)",
    [ALICE, BOB],
  );
  if (check.rows[0].n !== 2) {
    throw new Error(`setup gap: expected both stress profiles, saw ${check.rows[0].n}`);
  }
}

async function main() {
  const { Client } = loadPg();
  const setup = new Client({ connectionString: PG_URL });
  await setup.connect();
  const table = await setup.query(
    "select count(*)::int as n from pg_class where relname = 'user_saved_drills'",
  );
  if (table.rows[0].n !== 1) {
    throw new Error("public.user_saved_drills is absent — apply the shim + migrations first");
  }
  await ensureUsers(setup);
  await setup.end();

  // STRESS_REPLAY replays exactly the listed seeds (comma separated), which is
  // how a reported failure is reproduced without re-running its campaign, and
  // how a suspected flake is repeated N times.
  const seeds = [];
  if (REPLAY.length > 0) {
    for (let repeat = 0; repeat < REPLAY_TIMES; repeat += 1) seeds.push(...REPLAY);
  } else {
    for (let i = 0; i < ITERATIONS; i += 1) seeds.push(`${CAMPAIGN}:${i}`);
  }

  const results = new Array(seeds.length);
  let cursor = 0;
  const worker = async () => {
    const client = new Client({ connectionString: PG_URL });
    await client.connect();
    try {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= seeds.length) break;
        results[index] = await runIteration(client, seeds[index]);
      }
    } finally {
      await client.end();
    }
  };
  const startedAt = Date.now();
  await Promise.all(Array.from({ length: Math.max(1, WORKERS) }, worker));
  const elapsedMs = Date.now() - startedAt;

  const executed = results.filter(Boolean);
  const broken = executed.filter((r) => r.verdict === "BROKEN");
  const byCategory = {};
  for (const r of executed) {
    const key = `${r.op}/${r.slugCategory}`;
    byCategory[key] ??= { held: 0, broken: 0 };
    byCategory[key][r.verdict === "BROKEN" ? "broken" : "held"] += 1;
  }
  const summary = {
    campaign: CAMPAIGN,
    pgUrl: PG_URL.replace(/:\/\/[^@]*@/, "://***@"),
    iterationsRequested: ITERATIONS,
    scenariosExecuted: executed.length,
    workers: WORKERS,
    elapsedMs,
    broken: broken.length,
    accepted: executed.filter((r) => r.outcome === "accepted").length,
    rejected: executed.filter((r) => r.outcome === "rejected").length,
    sqlstates: executed.reduce((acc, r) => {
      if (r.sqlstate) acc[r.sqlstate] = (acc[r.sqlstate] ?? 0) + 1;
      return acc;
    }, {}),
    violationKinds: broken.reduce((acc, r) => {
      for (const v of r.violations) {
        const kind = v.split(":")[0];
        acc[kind] = (acc[kind] ?? 0) + 1;
      }
      return acc;
    }, {}),
    byCategory,
  };

  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(
      path.resolve(OUT),
      `${JSON.stringify({ summary, results: executed }, null, 2)}\n`,
    );
  }
  process.stderr.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (broken.length > 0) {
    const shown = broken.slice(0, 25);
    process.stderr.write(`\nBROKEN seeds (${broken.length} total, first ${shown.length}):\n`);
    for (const r of shown) {
      process.stderr.write(
        `  ${r.seed}  ${r.op}  ${r.slugCategory}/${r.tsCategory}  ${r.violations.join(",")}\n`,
      );
    }
    process.exit(1);
  }
  process.stderr.write("\nALL ITERATIONS HELD\n");
}

main().catch((error) => {
  process.stderr.write(`harness failure: ${error?.stack ?? error}\n`);
  process.exit(2);
});
