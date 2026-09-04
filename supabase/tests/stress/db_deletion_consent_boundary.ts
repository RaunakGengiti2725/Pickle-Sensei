// Boundary / malformed-input stress campaign for the `db-deletion-consent`
// unit: public.account_deletion_requests, public.account_deletion_feedback,
// public.consent_records, public.account_external_credentials and their
// auth.users → profiles → child cascades.
//
// Every iteration is derived from a single 32-bit seed (campaign seed + index
// via iterationSeed) and can be replayed alone with STRESS_REPLAY=<seed>.
// Each transactional iteration provisions its OWN two users inside a
// transaction that is always rolled back, so iterations never interfere and
// a replay reproduces exactly the same database state.
//
// Invariants asserted per iteration (a violation is recorded as BROKEN):
//   I1  The write either succeeds or fails with a TYPED, graceful SQLSTATE —
//       class 22 (data), 23 (integrity), 42501 (privilege / RLS / append-only
//       trigger) or 54 (program limit). Anything else (XX internal error,
//       08 connection, 57 operator intervention, 40P01 deadlock, driver
//       exception, connection loss) is BROKEN.
//   I2  A rejected write leaves the iteration's rows unchanged (never a
//       partial write).
//   I3  The oracle expectation holds: inputs the column contract says must be
//       rejected ARE rejected; inputs it says are valid ARE accepted (a false
//       rejection surfaces as a 503 in the edge function).
//   I4  An accepted row satisfies the declared caps when re-read as the table
//       owner (no cap bypass) and round-trips byte-for-byte (no silent
//       mutation) unless the input carried a lone surrogate.
//   I5  The connection survives (a trailing `select 1` succeeds).
//   Cross-user / role probes: authenticated never reads, writes or
//       reassigns another user's rows; service-only tables answer 42501 to
//       every client payload (valid or not).
//   Cascade: deleting auth.users removes every consent / request /
//       credential row and anonymises (user_id → NULL) every feedback row
//       while its content stays byte-identical; a bystander user is untouched.
//   Parallel: concurrent upserts converge to exactly one request row;
//       concurrent writes racing a user deletion never leave an owned row
//       behind. 40001 under SERIALIZABLE is retryable, not BROKEN.
//
// All values are bound as TEXT and cast server-side (`$n::text::<type>`) so
// the PostgreSQL input parsers — not the driver's JS serializers — are the
// boundary under test.
//
// Usage (see run_db_deletion_consent_stress.sh):
//   PICKLE_STRESS_PG_URL=postgres://postgres:x@127.0.0.1:5499/postgres \
//   STRESS_ITER=3000 STRESS_SEED=20260904 STRESS_OUT=/tmp/results.json \
//     deno run -A --no-check --config supabase/tests/stress/deno.json \
//       supabase/tests/stress/db_deletion_consent_boundary.ts

import postgres from "postgres";
import {
  chance,
  codepoints,
  type Expect,
  faultPlan,
  type Gen,
  genBool,
  genEnum,
  genJsonText,
  genNonNegInt,
  genText,
  genTimestamp,
  genUuid,
  int,
  iterationSeed,
  mulberry32,
  PG_VERSION_DEPENDENT_INT_KINDS,
  pick,
  randomUuid,
  type Rng,
  summarize,
} from "./generators.ts";

type Sql = ReturnType<typeof postgres>;
// deno-lint-ignore no-explicit-any
type Tx = any;

export type Outcome = "HELD" | "BROKEN";

export interface CaseResult {
  seed: number;
  index: number;
  scenario: string;
  table: string;
  outcome: Outcome;
  /** accept | reject | n/a — what the oracle predicted. */
  expected: string;
  /** ok | <SQLSTATE> | exception — what the DB did. */
  observed: string;
  message?: string;
  inputs: Record<string, string>;
  /** Invariant ids that failed (empty when HELD). */
  violations: string[];
  /** Exact SQL to replay by hand (psql-ready) when BROKEN. */
  repro?: string;
  ms: number;
}

export interface CampaignSummary {
  campaignSeed: number;
  iterations: number;
  executed: number;
  held: number;
  broken: number;
  byScenario: Record<string, { executed: number; broken: number }>;
  bySqlstate: Record<string, number>;
  brokenSeeds: number[];
  startedAt: string;
  finishedAt: string;
  pgVersion: string;
}

const GRACEFUL = /^(22|23|54)|^42501$/;
const RETRYABLE = /^40001$/;

const SCOPES = ["video_analysis", "model_training", "evaluation_telemetry"] as const;
const ACTIONS = ["grant", "withdraw"] as const;
const REASONS = [
  "not_using",
  "not_helpful",
  "scores_inaccurate",
  "technical_issues",
  "too_expensive",
  "privacy",
  "other",
];
const WANTED = ["accuracy", "price", "content", "stability", "switched", "nothing"];

const asUser = (uid: string) => `
  set local role authenticated;
  select set_config('request.jwt.claim.sub', '${uid}', true);
  select set_config('request.jwt.claim.role', 'authenticated', true);
  select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
`;
const asOwner = `reset role;`;
const provisionSql = (uid: string, provider: string) =>
  `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
   values ('${uid}', '${uid}@example.test', '{}'::jsonb, '{"provider":"${provider}"}'::jsonb);`;

interface PgError {
  code?: string;
  message: string;
}

function isPgError(e: unknown): e is PgError {
  return typeof e === "object" && e !== null && "message" in e;
}

/** Rows owned by the iteration's users (parallel iterations commit rows for
 * OTHER users, so global counts would be racy). */
async function ownedCount(tx: Tx, table: string, uids: string[]): Promise<number> {
  await tx.unsafe(asOwner);
  const r = await tx.unsafe(
    `select count(*)::int as n from public.${table} where user_id = any($1::uuid[])`,
    [uids],
  );
  return r[0].n as number;
}

interface Attempt {
  state: string;
  message?: string;
  rows?: unknown;
  affected: number;
}

/** Live oracle for integer spellings whose acceptance is a server-version
 * question (PG16+ non-decimal literals / underscores), not a contract one. */
async function intOracle(tx: Tx, g: Gen): Promise<Gen> {
  if (!PG_VERSION_DEPENDENT_INT_KINDS.has(g.kind)) return g;
  const probe = await attempt(tx, () => tx.unsafe(`select ($1::text::int >= 0) as ok`, [g.value]));
  const ok = probe.state === "ok" && (probe.rows as Array<{ ok: boolean }>)[0].ok === true;
  return {
    ...g,
    kind: `${g.kind}(pg-${ok ? "accepts" : "rejects"})`,
    expect: ok ? "accept" : "reject",
  };
}

/** Executes `fn` inside a savepoint; returns the SQLSTATE (or "ok"). */
async function attempt(tx: Tx, fn: () => Promise<unknown>): Promise<Attempt> {
  await tx.unsafe("savepoint s1");
  try {
    const rows = await fn();
    await tx.unsafe("release savepoint s1");
    const affected =
      typeof (rows as { count?: number })?.count === "number"
        ? (rows as { count: number }).count
        : Array.isArray(rows)
          ? rows.length
          : 0;
    return { state: "ok", rows, affected };
  } catch (e) {
    await tx.unsafe("rollback to savepoint s1");
    if (isPgError(e) && e.code) {
      return { state: e.code, message: e.message.slice(0, 200), affected: 0 };
    }
    return {
      state: "exception",
      message: String(e).slice(0, 200),
      affected: 0,
    };
  }
}

const literal = (v: string | null) => (v === null ? "NULL" : `'${v.replaceAll("'", "''")}'`);

/** psql-ready reproduction: provisioning + role switch + the statement. */
function reproSql(
  users: Array<[string, string]>,
  role: string | null,
  sql: string,
  params: Array<string | null>,
): string {
  let s = sql;
  for (let i = params.length; i >= 1; i--) {
    s = s.replaceAll(`$${i}`, literal(params[i - 1]));
  }
  const roleSql =
    role === null
      ? ""
      : role === "service_role" || role === "anon"
        ? `set local role ${role};`
        : asUser(role);
  return `begin;\n${users
    .map(([u, p]) => provisionSql(u, p))
    .join("\n")}\n${roleSql}\n${s};\nrollback;`;
}

// ─── Per-scenario cases ─────────────────────────────────────────────────────

interface Ctx {
  sql: Sql;
  seed: number;
  index: number;
  rng: Rng;
}

interface Verdict {
  table: string;
  expected: string;
  observed: string;
  message?: string;
  inputs: Record<string, string>;
  violations: string[];
  repro?: string;
}

interface Users {
  a: string;
  b: string;
  list: Array<[string, string]>;
}

/** Two fresh users inside the (rolled back) transaction; the auth.users
 * trigger creates their profiles. */
async function provisionPair(rng: Rng, tx: Tx): Promise<Users> {
  const a = randomUuid(rng);
  const b = randomUuid(rng);
  const list: Array<[string, string]> = [
    [a, "google"],
    [b, "apple"],
  ];
  await tx.unsafe(asOwner);
  for (const [uid, provider] of list) {
    await tx.unsafe(provisionSql(uid, provider));
  }
  return { a, b, list };
}

function judge(expected: Expect | "n/a", res: Attempt, violations: string[]) {
  if (res.state !== "ok" && !GRACEFUL.test(res.state)) {
    violations.push(`I1:untyped-error(${res.state})`);
  }
  if (expected === "accept" && res.state !== "ok") {
    violations.push("I3:false-rejection");
  }
  if (expected === "reject" && res.state === "ok") {
    violations.push("I3:accepted-invalid-input");
  }
}

const roundtrip = (g: Gen, stored: string | null) => g.value === stored || g.loneSurrogate === true;

function insertSql(table: string, cols: string[], casts: string[], returning?: string) {
  return `insert into public.${table} (${cols.join(", ")}) values (${cols
    .map((_, i) => `$${i + 1}::text::${casts[i]}`)
    .join(", ")})${returning ? ` returning ${returning}` : ""}`;
}

/** consent_records INSERT as the authenticated owner (edge grant/withdraw path). */
async function caseConsentInsert(c: Ctx, tx: Tx): Promise<Verdict> {
  const { rng } = c;
  const users = await provisionPair(rng, tx);
  const uid = pick(rng, [users.a, users.b]);
  const other = uid === users.a ? users.b : users.a;
  const plan = faultPlan(rng, 8);
  const userId = plan.field(0, () => genUuid(rng, uid, other, { nullExpect: "reject" }));
  const scope = plan.field(1, () =>
    chance(rng, 0.5)
      ? {
          value: pick(rng, SCOPES),
          kind: "valid-scope",
          expect: "accept" as Expect,
        }
      : genText(rng, 50, false),
  );
  const version = plan.field(2, () => genText(rng, 50, true));
  const action = plan.field(3, () => genEnum(rng, ACTIONS, 50));
  const source = plan.field(4, () => genText(rng, 100, true));
  const capture = plan.field(5, () => genText(rng, 50, true));
  const device = plan.field(6, () => genJsonText(rng, 4096));
  const createdAt = chance(rng, 0.7) ? null : plan.field(7, () => genTimestamp(rng, false));

  // Live oracle for the jsonb parse + size cap.
  let deviceExpect: Expect = "accept";
  if (device.value !== null) {
    const probe = await attempt(tx, () =>
      tx.unsafe(`select pg_column_size($1::text::jsonb)::int as n`, [device.value]),
    );
    if (probe.state !== "ok") deviceExpect = "reject";
    else {
      deviceExpect = (probe.rows as Array<{ n: number }>)[0].n <= 4096 ? "accept" : "reject";
    }
  }
  const gens: Array<{ expect: Expect }> = [userId, scope, version, action, source, capture];
  if (createdAt) gens.push(createdAt);
  const expected: Expect =
    gens.every((g) => g.expect === "accept") && deviceExpect === "accept" ? "accept" : "reject";

  const cols = [
    "user_id",
    "scope",
    "consent_version",
    "action",
    "source",
    "capture_mode",
    "device",
  ];
  const casts = ["uuid", "text", "text", "text", "text", "text", "jsonb"];
  const params: Array<string | null> = [
    userId.value,
    scope.value,
    version.value,
    action.value,
    source.value,
    capture.value,
    device.value,
  ];
  if (createdAt) {
    cols.push("created_at");
    casts.push("timestamptz");
    params.push(createdAt.value);
  }
  const sql = insertSql("consent_records", cols, casts, "id");
  const owned = [users.a, users.b];
  const before = await ownedCount(tx, "consent_records", owned);
  await tx.unsafe(asUser(uid));
  const res = await attempt(tx, () => tx.unsafe(sql, params));
  const after = await ownedCount(tx, "consent_records", owned);

  const violations: string[] = [];
  judge(expected, res, violations);
  if (res.state !== "ok" && after !== before) {
    violations.push("I2:write-despite-rejection");
  }
  if (res.state === "ok") {
    if (after !== before + 1) {
      violations.push("I2:row-count-mismatch-on-accept");
    }
    const id = (res.rows as Array<{ id: string }>)[0].id;
    const row = (
      await tx.unsafe(
        `select user_id::text, scope, consent_version, action, source, capture_mode, device::text as device,
                length(scope) <= 50 and coalesce(length(consent_version),0) <= 50
                and coalesce(length(source),0) <= 100 and coalesce(length(capture_mode),0) <= 50
                and coalesce(pg_column_size(device),0) <= 4096 and action in ('grant','withdraw') as within_caps
           from public.consent_records where id = $1::uuid`,
        [id],
      )
    )[0];
    if (!row.within_caps) violations.push("I4:cap-bypass");
    if (row.user_id !== uid) violations.push("I4:owner-mismatch");
    if (!roundtrip(scope, row.scope)) violations.push("I4:mutated(scope)");
    if (!roundtrip(version, row.consent_version)) {
      violations.push("I4:mutated(consent_version)");
    }
    if (!roundtrip(source, row.source)) violations.push("I4:mutated(source)");
    if (!roundtrip(capture, row.capture_mode)) {
      violations.push("I4:mutated(capture_mode)");
    }
  }
  return {
    table: "consent_records",
    expected,
    observed: res.state,
    message: res.message,
    inputs: {
      actor: uid,
      plan: plan.mode,
      user_id: `${userId.kind}=${summarize(userId.value)}`,
      scope: `${scope.kind}=${summarize(scope.value)}`,
      consent_version: `${version.kind}=${summarize(version.value)}`,
      action: `${action.kind}=${summarize(action.value)}`,
      source: `${source.kind}=${summarize(source.value)}`,
      capture_mode: `${capture.kind}=${summarize(capture.value)}`,
      device: `${device.kind}(oracle=${deviceExpect})=${summarize(device.value)}`,
      ...(createdAt ? { created_at: `${createdAt.kind}=${summarize(createdAt.value)}` } : {}),
    },
    violations,
    repro: violations.length ? reproSql(users.list, uid, sql, params) : undefined,
  };
}

/** account_deletion_feedback INSERT as the authenticated owner (exit survey).
 * The client holds INSERT only (no SELECT ⇒ no RETURNING), so the row id is
 * supplied by the harness and re-read as the owner. */
async function caseFeedbackInsert(c: Ctx, tx: Tx): Promise<Verdict> {
  const { rng } = c;
  const users = await provisionPair(rng, tx);
  const uid = pick(rng, [users.a, users.b]);
  const other = uid === users.a ? users.b : users.a;
  const plan = faultPlan(rng, 12);
  const userId = plan.field(0, () => genUuid(rng, uid, other, { nullExpect: "reject" }));
  const reason = plan.field(1, () =>
    chance(rng, 0.4)
      ? {
          value: pick(rng, REASONS),
          kind: "valid-reason",
          expect: "accept" as Expect,
        }
      : genText(rng, 50, false),
  );
  const wanted = plan.field(2, () =>
    chance(rng, 0.4)
      ? {
          value: pick(rng, WANTED),
          kind: "valid-wanted",
          expect: "accept" as Expect,
        }
      : genText(rng, 50, true),
  );
  const details = plan.field(3, () => genText(rng, 1000, true));
  const provider = plan.field(4, () => genText(rng, 50, true));
  const platform = plan.field(5, () => genText(rng, 20, true));
  const appVersion = plan.field(6, () => genText(rng, 64, true));
  const age = await intOracle(
    tx,
    plan.field(7, () => genNonNegInt(rng)),
  );
  const premium = plan.field(8, () => genBool(rng));
  const scored = await intOracle(
    tx,
    plan.field(9, () => genNonNegInt(rng)),
  );
  const createdAt = chance(rng, 0.8) ? null : plan.field(10, () => genTimestamp(rng, false));

  // id: harness-generated (valid) most of the time; else a boundary variant.
  const freshId = randomUuid(rng);
  let id: Gen = { value: freshId, kind: "generated", expect: "accept" };
  const idRoll = plan.mode === "multi-fault" || plan.mode === "single-fault@11" ? rng() : 1;
  if (idRoll < 0.1) {
    // Duplicate of a row that already exists → 23505.
    await tx.unsafe(asOwner);
    await tx.unsafe(
      `insert into public.account_deletion_feedback (id, user_id, reason) values ($1::uuid, $2::uuid, 'other')`,
      [freshId, other],
    );
    id = { value: freshId, kind: "duplicate-id", expect: "reject" };
  } else if (idRoll < 0.25) {
    const g = genUuid(rng, randomUuid(rng), randomUuid(rng));
    id = {
      ...g,
      expect: g.kind === "malformed-uuid" || g.kind === "null" ? "reject" : "accept",
    };
  }

  const gens: Array<{ expect: Expect }> = [
    userId,
    reason,
    wanted,
    details,
    provider,
    platform,
    appVersion,
    age,
    premium,
    scored,
    id,
  ];
  if (createdAt) gens.push(createdAt);
  const expected: Expect = gens.every((g) => g.expect === "accept") ? "accept" : "reject";

  const cols = [
    "id",
    "user_id",
    "reason",
    "wanted",
    "details",
    "provider",
    "platform",
    "app_version",
    "account_age_days",
    "was_premium",
    "scored_count",
  ];
  const casts = [
    "uuid",
    "uuid",
    "text",
    "text",
    "text",
    "text",
    "text",
    "text",
    "int",
    "boolean",
    "int",
  ];
  const params: Array<string | null> = [
    id.value,
    userId.value,
    reason.value,
    wanted.value,
    details.value,
    provider.value,
    platform.value,
    appVersion.value,
    age.value,
    premium.value,
    scored.value,
  ];
  if (createdAt) {
    cols.push("created_at");
    casts.push("timestamptz");
    params.push(createdAt.value);
  }
  const sql = insertSql("account_deletion_feedback", cols, casts);
  const owned = [users.a, users.b];
  const before = await ownedCount(tx, "account_deletion_feedback", owned);
  await tx.unsafe(asUser(uid));
  const res = await attempt(tx, () => tx.unsafe(sql, params));
  // The client must never be able to read the survey back (no SELECT grant).
  const readBack = await attempt(tx, () =>
    tx.unsafe(`select id from public.account_deletion_feedback where user_id = $1::uuid`, [uid]),
  );
  const after = await ownedCount(tx, "account_deletion_feedback", owned);

  const violations: string[] = [];
  judge(expected, res, violations);
  if (readBack.state !== "42501") {
    violations.push(`RLS:client-can-read-feedback(${readBack.state})`);
  }
  if (res.state !== "ok" && after !== before) {
    violations.push("I2:write-despite-rejection");
  }
  if (res.state === "ok") {
    if (after !== before + 1) {
      violations.push("I2:row-count-mismatch-on-accept");
    }
    const rows = await tx.unsafe(
      `select user_id::text, reason, wanted, details, provider, platform, app_version,
              length(reason) <= 50 and coalesce(length(wanted),0) <= 50 and coalesce(length(details),0) <= 1000
              and coalesce(length(provider),0) <= 50 and coalesce(length(platform),0) <= 20
              and coalesce(length(app_version),0) <= 64
              and (account_age_days is null or account_age_days >= 0)
              and (scored_count is null or scored_count >= 0) as within_caps
         from public.account_deletion_feedback where id = $1::text::uuid`,
      [id.value],
    );
    const row = rows[0];
    if (!row) violations.push("I2:accepted-row-not-found");
    else {
      if (!row.within_caps) violations.push("I4:cap-bypass");
      if (row.user_id !== uid) violations.push("I4:owner-mismatch");
      if (!roundtrip(reason, row.reason)) violations.push("I4:mutated(reason)");
      if (!roundtrip(wanted, row.wanted)) violations.push("I4:mutated(wanted)");
      if (!roundtrip(details, row.details)) {
        violations.push("I4:mutated(details)");
      }
      if (!roundtrip(provider, row.provider)) {
        violations.push("I4:mutated(provider)");
      }
      if (!roundtrip(platform, row.platform)) {
        violations.push("I4:mutated(platform)");
      }
      if (!roundtrip(appVersion, row.app_version)) {
        violations.push("I4:mutated(app_version)");
      }
    }
  }
  return {
    table: "account_deletion_feedback",
    expected,
    observed: res.state,
    message: res.message,
    inputs: {
      actor: uid,
      plan: plan.mode,
      id: `${id.kind}=${summarize(id.value)}`,
      user_id: `${userId.kind}=${summarize(userId.value)}`,
      reason: `${reason.kind}=${summarize(reason.value)}`,
      wanted: `${wanted.kind}=${summarize(wanted.value)}`,
      details: `${details.kind}=${summarize(details.value)}`,
      provider: `${provider.kind}=${summarize(provider.value)}`,
      platform: `${platform.kind}=${summarize(platform.value)}`,
      app_version: `${appVersion.kind}=${summarize(appVersion.value)}`,
      account_age_days: `${age.kind}=${summarize(age.value)}`,
      was_premium: `${premium.kind}=${summarize(premium.value)}`,
      scored_count: `${scored.kind}=${summarize(scored.value)}`,
      ...(createdAt ? { created_at: `${createdAt.kind}=${summarize(createdAt.value)}` } : {}),
      read_back: readBack.state,
    },
    violations,
    repro: violations.length ? reproSql(users.list, uid, sql, params) : undefined,
  };
}

/** account_deletion_requests PostgREST-shaped upsert (merge-duplicates puts
 * EVERY payload column in DO UPDATE) as the authenticated owner. */
async function caseDeletionRequestUpsert(c: Ctx, tx: Tx): Promise<Verdict> {
  const { rng } = c;
  const users = await provisionPair(rng, tx);
  const uid = pick(rng, [users.a, users.b]);
  const other = uid === users.a ? users.b : users.a;
  const preExisting = chance(rng, 0.5);
  const otherHasRow = chance(rng, 0.5);
  const plan = faultPlan(rng, 4);
  const userId = plan.field(0, () => genUuid(rng, uid, other, { nullExpect: "reject" }));
  const challenge = plan.field(1, () => {
    const g = genUuid(rng, randomUuid(rng), randomUuid(rng));
    return {
      ...g,
      expect: g.kind === "malformed-uuid" || g.kind === "null" ? "reject" : "accept",
    };
  });
  const createdAt = plan.field(2, () => genTimestamp(rng, false));
  const expiresAt = plan.field(3, () => genTimestamp(rng, false));
  const expected: Expect = [
    userId.expect,
    challenge.expect,
    createdAt.expect,
    expiresAt.expect,
  ].every((e) => e === "accept")
    ? "accept"
    : "reject";

  const sql = `insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
    values ($1::text::uuid, $2::text::uuid, $3::text::timestamptz, $4::text::timestamptz)
    on conflict (user_id) do update set user_id = excluded.user_id, challenge = excluded.challenge,
      created_at = excluded.created_at, expires_at = excluded.expires_at
    returning user_id::text, challenge::text`;
  const params = [userId.value, challenge.value, createdAt.value, expiresAt.value];

  await tx.unsafe(asOwner);
  if (preExisting) {
    await tx.unsafe(`insert into public.account_deletion_requests (user_id) values ($1::uuid)`, [
      uid,
    ]);
  }
  if (otherHasRow) {
    await tx.unsafe(`insert into public.account_deletion_requests (user_id) values ($1::uuid)`, [
      other,
    ]);
  }
  const owned = [users.a, users.b];
  const before = await ownedCount(tx, "account_deletion_requests", owned);
  const otherBefore =
    (
      await tx.unsafe(
        `select challenge::text as ch from public.account_deletion_requests where user_id = $1::uuid`,
        [other],
      )
    )[0]?.ch ?? null;
  await tx.unsafe(asUser(uid));
  const res = await attempt(tx, () => tx.unsafe(sql, params));
  // Owner must see exactly their own row (never the other user's).
  const visible = await attempt(tx, () =>
    tx.unsafe(`select user_id::text from public.account_deletion_requests`),
  );
  const after = await ownedCount(tx, "account_deletion_requests", owned);
  const otherAfter =
    (
      await tx.unsafe(
        `select challenge::text as ch from public.account_deletion_requests where user_id = $1::uuid`,
        [other],
      )
    )[0]?.ch ?? null;

  const violations: string[] = [];
  judge(expected, res, violations);
  if (res.state !== "ok" && after !== before) {
    violations.push("I2:write-despite-rejection");
  }
  if (otherAfter !== otherBefore) {
    violations.push("RLS:other-users-row-changed");
  }
  const seen = (visible.rows as Array<{ user_id: string }> | undefined) ?? [];
  if (visible.state !== "ok" || seen.some((r) => r.user_id !== uid)) {
    violations.push("RLS:foreign-row-visible");
  }
  if (res.state === "ok") {
    if (after !== before + (preExisting ? 0 : 1)) {
      violations.push("I2:row-count-mismatch-on-accept");
    }
    const row = (res.rows as Array<{ user_id: string }>)[0];
    if (row.user_id !== uid) violations.push("I4:owner-mismatch");
  }
  return {
    table: "account_deletion_requests",
    expected,
    observed: res.state,
    message: res.message,
    inputs: {
      actor: uid,
      plan: plan.mode,
      pre_existing: String(preExisting),
      other_has_row: String(otherHasRow),
      user_id: `${userId.kind}=${summarize(userId.value)}`,
      challenge: `${challenge.kind}=${summarize(challenge.value)}`,
      created_at: `${createdAt.kind}=${summarize(createdAt.value)}`,
      expires_at: `${expiresAt.kind}=${summarize(expiresAt.value)}`,
    },
    violations,
    repro: violations.length ? reproSql(users.list, uid, sql, params) : undefined,
  };
}

/** account_external_credentials upsert as the service role (edge admin client). */
async function caseCredentialsServiceWrite(c: Ctx, tx: Tx): Promise<Verdict> {
  const { rng } = c;
  const users = await provisionPair(rng, tx);
  const uid = pick(rng, [users.a, users.b]);
  const other = uid === users.a ? users.b : users.a;
  // Service role writes any real user; unknown users hit the FK.
  const plan = faultPlan(rng, 5);
  const userId = plan.field(0, () =>
    genUuid(rng, uid, other, {
      otherExpect: "accept",
      nullExpect: "reject",
    }),
  );
  // Token: 20..8192 codepoints, paired with captured_at.
  const genToken = (): Gen => {
    const roll = rng();
    let token: Gen;
    if (roll < 0.15) token = { value: null, kind: "null", expect: "accept" };
    else if (roll < 0.3) {
      token = { value: "x".repeat(19), kind: "len-19", expect: "reject" };
    } else if (roll < 0.45) {
      token = { value: "x".repeat(20), kind: "len-20", expect: "accept" };
    } else if (roll < 0.6) {
      token = {
        value: "😀".repeat(8192),
        kind: "len-8192(4byte)",
        expect: "accept",
      };
    } else if (roll < 0.75) {
      token = { value: "x".repeat(8193), kind: "len-8193", expect: "reject" };
    } else token = genText(rng, 8192, true);
    if (token.value !== null && codepoints(token.value) < 20) {
      token = { ...token, expect: "reject" };
    }
    return token;
  };
  const token = plan.field(1, genToken);
  const captured = plan.field(2, () =>
    chance(rng, 0.7)
      ? {
          value: token.value === null ? null : "2026-09-04T12:00:00Z",
          kind: "paired",
          expect: "accept",
        }
      : {
          value: token.value === null ? "2026-09-04T12:00:00Z" : null,
          kind: "unpaired",
          expect: "reject",
        },
  );
  const revoked = plan.field(3, () => genTimestamp(rng, true));
  const rcDeleted = plan.field(4, () => genTimestamp(rng, true));
  const expected: Expect = [userId, token, captured, revoked, rcDeleted].every(
    (g) => g.expect === "accept",
  )
    ? "accept"
    : "reject";
  const sql = `insert into public.account_external_credentials
      (user_id, apple_refresh_token_encrypted, apple_token_captured_at, apple_revoked_at, revenuecat_deleted_at, updated_at)
    values ($1::text::uuid, $2::text, $3::text::timestamptz, $4::text::timestamptz, $5::text::timestamptz, now())
    on conflict (user_id) do update set apple_refresh_token_encrypted = excluded.apple_refresh_token_encrypted,
      apple_token_captured_at = excluded.apple_token_captured_at, apple_revoked_at = excluded.apple_revoked_at,
      revenuecat_deleted_at = excluded.revenuecat_deleted_at, updated_at = excluded.updated_at
    returning user_id::text`;
  const params = [userId.value, token.value, captured.value, revoked.value, rcDeleted.value];

  const owned = [users.a, users.b];
  const before = await ownedCount(tx, "account_external_credentials", owned);
  await tx.unsafe(`set local role service_role;`);
  const res = await attempt(tx, () => tx.unsafe(sql, params));
  const after = await ownedCount(tx, "account_external_credentials", owned);
  const violations: string[] = [];
  judge(expected, res, violations);
  if (res.state !== "ok" && after !== before) {
    violations.push("I2:write-despite-rejection");
  }
  if (res.state === "ok") {
    const row = (
      await tx.unsafe(
        `select (apple_refresh_token_encrypted is null) = (apple_token_captured_at is null)
                and (apple_refresh_token_encrypted is null or length(apple_refresh_token_encrypted) between 20 and 8192) as within_caps,
                apple_refresh_token_encrypted as token
           from public.account_external_credentials where user_id = $1::uuid`,
        [(res.rows as Array<{ user_id: string }>)[0].user_id],
      )
    )[0];
    if (!row.within_caps) violations.push("I4:cap-bypass");
    if (!roundtrip(token, row.token)) violations.push("I4:mutated(token)");
  }
  return {
    table: "account_external_credentials",
    expected,
    observed: res.state,
    message: res.message,
    inputs: {
      actor: "service_role",
      plan: plan.mode,
      user_id: `${userId.kind}=${summarize(userId.value)}`,
      apple_refresh_token_encrypted: `${token.kind}=${summarize(token.value)}`,
      apple_token_captured_at: `${captured.kind}=${summarize(captured.value)}`,
      apple_revoked_at: `${revoked.kind}=${summarize(revoked.value)}`,
      revenuecat_deleted_at: `${rcDeleted.kind}=${summarize(rcDeleted.value)}`,
    },
    violations,
    repro: violations.length ? reproSql(users.list, "service_role", sql, params) : undefined,
  };
}

/** Any client payload against the service-only credentials table → 42501. */
async function caseCredentialsClientProbe(c: Ctx, tx: Tx): Promise<Verdict> {
  const { rng } = c;
  const users = await provisionPair(rng, tx);
  const uid = pick(rng, [users.a, users.b]);
  const other = uid === users.a ? users.b : users.a;
  const target = genUuid(rng, uid, other);
  const tokenG = genText(rng, 8192, true);
  const token = tokenG.value === null ? "x".repeat(32) : tokenG.value;
  const op = pick(rng, ["select", "insert", "update", "delete", "upsert", "count"]);
  const statements: Record<string, [string, Array<string | null>]> = {
    select: [
      `select * from public.account_external_credentials where user_id = $1::text::uuid`,
      [target.value],
    ],
    count: [`select count(*) from public.account_external_credentials`, []],
    insert: [
      `insert into public.account_external_credentials (user_id, apple_refresh_token_encrypted, apple_token_captured_at) values ($1::text::uuid, $2::text, now())`,
      [target.value, token],
    ],
    upsert: [
      `insert into public.account_external_credentials (user_id, apple_refresh_token_encrypted, apple_token_captured_at) values ($1::text::uuid, $2::text, now()) on conflict (user_id) do update set apple_refresh_token_encrypted = excluded.apple_refresh_token_encrypted`,
      [target.value, token],
    ],
    update: [
      `update public.account_external_credentials set apple_revoked_at = now() where user_id = $1::text::uuid`,
      [target.value],
    ],
    delete: [
      `delete from public.account_external_credentials where user_id = $1::text::uuid`,
      [target.value],
    ],
  };
  const [sql, params] = statements[op];
  // Seed a real row so the probe has something to hit.
  await tx.unsafe(asOwner);
  await tx.unsafe(
    `insert into public.account_external_credentials (user_id, apple_refresh_token_encrypted, apple_token_captured_at)
     values ($1::uuid, repeat('t', 40), now())`,
    [uid],
  );
  const owned = [users.a, users.b];
  const before = await ownedCount(tx, "account_external_credentials", owned);
  const role = pick(rng, ["authenticated", "anon"]);
  if (role === "authenticated") await tx.unsafe(asUser(uid));
  else await tx.unsafe(`set local role anon;`);
  const res = await attempt(tx, () => tx.unsafe(sql, params));
  const after = await ownedCount(tx, "account_external_credentials", owned);
  const violations: string[] = [];
  // A malformed uuid literal fails in the planner (22P02) before the
  // executor's privilege check runs; well-formed targets must hit 42501.
  const malformedTarget = target.kind === "malformed-uuid";
  if (res.state !== "42501" && !(malformedTarget && /^22/.test(res.state))) {
    violations.push(`RLS:client-reached-service-table(${res.state})`);
  }
  if (after !== before) violations.push("I2:write-despite-rejection");
  return {
    table: "account_external_credentials",
    expected: "reject",
    observed: res.state,
    message: res.message,
    inputs: {
      actor: role,
      op,
      user_id: `${target.kind}=${summarize(target.value)}`,
      token: `${tokenG.kind}=${summarize(token)}`,
    },
    violations,
    repro: violations.length
      ? reproSql(users.list, role === "authenticated" ? uid : role, sql, params)
      : undefined,
  };
}

/** One user against the other's rows (and malformed targets) on every client table. */
async function caseCrossUser(c: Ctx, tx: Tx): Promise<Verdict> {
  const { rng } = c;
  const users = await provisionPair(rng, tx);
  const actor = pick(rng, [users.a, users.b]);
  const victim = actor === users.a ? users.b : users.a;
  // "own" here means the VICTIM (the interesting target); "other-user" = actor.
  const target = genUuid(rng, victim, actor, { otherExpect: "reject" });
  const op = pick(rng, [
    "adr_select",
    "adr_update",
    "adr_delete",
    "adr_upsert",
    "adr_reassign_own",
    "cr_select",
    "cr_insert",
    "adf_insert",
  ]);
  const payload = genText(rng, 50, false);
  const statements: Record<string, [string, Array<string | null>]> = {
    adr_select: [
      `select user_id::text from public.account_deletion_requests where user_id = $1::text::uuid`,
      [target.value],
    ],
    adr_update: [
      `update public.account_deletion_requests set challenge = gen_random_uuid(), expires_at = 'infinity' where user_id = $1::text::uuid returning user_id::text`,
      [target.value],
    ],
    adr_delete: [
      `delete from public.account_deletion_requests where user_id = $1::text::uuid returning user_id::text`,
      [target.value],
    ],
    adr_upsert: [
      `insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at) values ($1::text::uuid, gen_random_uuid(), now(), now() + interval '15 minutes')
       on conflict (user_id) do update set user_id = excluded.user_id, challenge = excluded.challenge, created_at = excluded.created_at, expires_at = excluded.expires_at returning user_id::text`,
      [target.value],
    ],
    adr_reassign_own: [
      `update public.account_deletion_requests set user_id = $1::text::uuid where user_id = $2::text::uuid returning user_id::text`,
      [target.value, actor],
    ],
    cr_select: [
      `select user_id::text from public.consent_records where user_id = $1::text::uuid`,
      [target.value],
    ],
    cr_insert: [
      `insert into public.consent_records (user_id, scope, action, consent_version) values ($1::text::uuid, 'model_training', 'grant', $2::text) returning user_id::text`,
      [target.value, payload.value],
    ],
    adf_insert: [
      `insert into public.account_deletion_feedback (user_id, reason, details) values ($1::text::uuid, 'other', $2::text)`,
      [target.value, payload.value],
    ],
  };
  const [sql, params] = statements[op];

  // Victim owns one row in each table; actor owns a deletion request too.
  await tx.unsafe(asOwner);
  await tx.unsafe(
    `insert into public.account_deletion_requests (user_id) values ($1::uuid), ($2::uuid)`,
    [victim, actor],
  );
  await tx.unsafe(
    `insert into public.consent_records (user_id, scope, action, consent_version) values ($1::uuid, 'model_training', 'grant', 'v1')`,
    [victim],
  );
  await tx.unsafe(
    `insert into public.account_deletion_feedback (user_id, reason) values ($1::uuid, 'other')`,
    [victim],
  );
  const snapshot = async (who: string) => {
    await tx.unsafe(asOwner);
    return (
      await tx.unsafe(
        `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h from (
          select 'adr', user_id, challenge, created_at, expires_at from public.account_deletion_requests where user_id = $1::uuid
          union all select 'cr', user_id, id, created_at, null from public.consent_records where user_id = $1::uuid
          union all select 'adf', user_id, id, created_at, null from public.account_deletion_feedback where user_id = $1::uuid
        ) t`,
        [who],
      )
    )[0].h as string;
  };
  const victimBefore = await snapshot(victim);
  const actorBefore = await snapshot(actor);
  await tx.unsafe(asUser(actor));
  const res = await attempt(tx, () => tx.unsafe(sql, params));
  const victimAfter = await snapshot(victim);
  const actorAfter = await snapshot(actor);

  const violations: string[] = [];
  const rows = (res.rows as Array<{ user_id: string }> | undefined) ?? [];
  const norm = (v: string | null) => (v ?? "").toLowerCase().replace(/[{}-]/g, "");
  const targetIsVictim = norm(target.value) === norm(victim);
  const targetIsActor = norm(target.value) === norm(actor);
  const isWrite = !op.endsWith("select");
  if (victimAfter !== victimBefore) violations.push("RLS:victim-state-mutated");
  if (res.state === "ok") {
    if (rows.some((r) => r.user_id !== actor)) {
      violations.push("RLS:foreign-row-returned");
    }
    if (isWrite && res.affected > 0 && !targetIsActor) {
      violations.push("RLS:write-for-other-identity-accepted");
    }
    if (!isWrite && actorAfter !== actorBefore) {
      violations.push("I2:read-mutated-state");
    }
  } else {
    if (!GRACEFUL.test(res.state)) {
      violations.push(`I1:untyped-error(${res.state})`);
    }
    if (actorAfter !== actorBefore) {
      violations.push("I2:write-despite-rejection");
    }
  }
  return {
    table: op.startsWith("adr")
      ? "account_deletion_requests"
      : op.startsWith("cr")
        ? "consent_records"
        : "account_deletion_feedback",
    expected: "n/a",
    observed: res.state,
    message: res.message,
    inputs: {
      actor,
      victim,
      op,
      target: `${
        target.kind === "own" ? "victim" : target.kind === "other-user" ? "actor" : target.kind
      }=${summarize(target.value)}`,
      payload: `${payload.kind}=${summarize(payload.value)}`,
      rows_affected: String(res.affected),
      target_is_victim: String(targetIsVictim),
    },
    violations,
    repro: violations.length ? reproSql(users.list, actor, sql, params) : undefined,
  };
}

/** UPDATE / DELETE on the append-only ledgers: client → 42501 (grant), owner
 * / service_role → 42501 (trigger, when a row matches). Malformed predicates
 * may fail earlier (22xxx). */
async function caseLedgerMutation(c: Ctx, tx: Tx): Promise<Verdict> {
  const { rng } = c;
  const users = await provisionPair(rng, tx);
  const uid = pick(rng, [users.a, users.b]);
  const other = uid === users.a ? users.b : users.a;
  const table = pick(rng, ["consent_records", "account_deletion_feedback"]);
  const role = pick(rng, ["authenticated", "authenticated", "anon", "owner", "service_role"]);
  // TRUNCATE fires no row triggers, so the append-only guard for it is the
  // (absent) client grant; owner/service_role legitimately hold it.
  const clientRole = role === "authenticated" || role === "anon";
  const op = pick(rng, clientRole ? ["update", "delete", "truncate"] : ["update", "delete"]);
  const target = genUuid(rng, uid, other, { otherExpect: "accept" });
  const payload = genText(rng, 50, false);
  const setCol = table === "consent_records" ? "consent_version" : "details";
  const statements: Record<string, [string, Array<string | null>]> = {
    update: [
      `update public.${table} set ${setCol} = $2::text where user_id = $1::text::uuid`,
      [target.value, payload.value],
    ],
    delete: [`delete from public.${table} where user_id = $1::text::uuid`, [target.value]],
    truncate: [`truncate public.${table}`, []],
  };
  const [sql, params] = statements[op];
  await tx.unsafe(asOwner);
  for (const u of [uid, other]) {
    if (table === "consent_records") {
      await tx.unsafe(
        `insert into public.consent_records (user_id, scope, action, consent_version) values ($1::uuid, 'video_analysis', 'grant', 'v1')`,
        [u],
      );
    } else {
      await tx.unsafe(
        `insert into public.account_deletion_feedback (user_id, reason, details) values ($1::uuid, 'privacy', 'seed')`,
        [u],
      );
    }
  }
  const hashSql = `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h from public.${table} t where user_id = any($1::uuid[])`;
  const before = (await tx.unsafe(hashSql, [[uid, other]]))[0].h;
  if (role === "authenticated") await tx.unsafe(asUser(uid));
  else if (role === "anon") await tx.unsafe(`set local role anon;`);
  else if (role === "service_role") {
    await tx.unsafe(`set local role service_role;`);
  }
  const res = await attempt(tx, () => tx.unsafe(sql, params));
  await tx.unsafe(asOwner);
  const after = (await tx.unsafe(hashSql, [[uid, other]]))[0].h;
  const violations: string[] = [];
  if (res.state === "ok" && (res.affected > 0 || op === "truncate")) {
    violations.push("APPEND-ONLY:mutation-succeeded");
  } else if (res.state !== "ok" && !GRACEFUL.test(res.state)) {
    violations.push(`I1:untyped-error(${res.state})`);
  }
  if (after !== before) violations.push("I2:ledger-changed");
  return {
    table,
    expected: "reject",
    observed: res.state,
    message: res.message,
    inputs: {
      actor: role,
      op,
      target: `${target.kind}=${summarize(target.value)}`,
      payload: `${payload.kind}=${summarize(payload.value)}`,
      rows_affected: String(res.affected),
    },
    violations,
    repro: violations.length
      ? reproSql(
          users.list,
          role === "authenticated" ? uid : role === "owner" ? null : role,
          sql,
          params,
        )
      : undefined,
  };
}

/** Full cascade with boundary-shaped rows in every child table; a bystander
 * user with the same shape must be untouched. */
async function caseCascade(c: Ctx, tx: Tx): Promise<Verdict> {
  const { rng } = c;
  const users = await provisionPair(rng, tx);
  const uid = users.a;
  const bystander = users.b;
  const nConsent = int(rng, 0, 40);
  const nFeedback = int(rng, 0, 6);
  const via = pick(rng, ["auth.users", "public.profiles"]);
  const hasAdr = chance(rng, 0.7);
  const hasAec = chance(rng, 0.7);
  const validText = (cap: number) => {
    let g = genText(rng, cap, false);
    while (g.expect !== "accept" || g.loneSurrogate) {
      g = genText(rng, cap, false);
    }
    return g.value;
  };
  await tx.unsafe(asOwner);
  await tx.unsafe(
    `insert into auth.identities (provider_id, user_id, identity_data, provider) values ($1::text, $2::uuid, jsonb_build_object('sub', $1::text), 'apple')`,
    [`apple-${uid}`, uid],
  );
  const seedRows = async (
    who: string,
    consent: number,
    feedback: number,
    adr: boolean,
    aec: boolean,
  ) => {
    for (let i = 0; i < consent; i++) {
      await tx.unsafe(
        `insert into public.consent_records (user_id, scope, action, consent_version, source, device) values ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text::jsonb)`,
        [
          who,
          pick(rng, SCOPES),
          pick(rng, ACTIONS),
          validText(50),
          validText(100),
          '{"__proto__":{"x":1}}',
        ],
      );
    }
    for (let i = 0; i < feedback; i++) {
      await tx.unsafe(
        `insert into public.account_deletion_feedback (user_id, reason, wanted, details, provider, platform, app_version, account_age_days, was_premium, scored_count)
         values ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, 2147483647, true, 0)`,
        [
          who,
          validText(50),
          validText(50),
          validText(1000),
          validText(50),
          validText(20),
          validText(64),
        ],
      );
    }
    if (adr) {
      await tx.unsafe(
        `insert into public.account_deletion_requests (user_id, expires_at) values ($1::uuid, 'infinity')`,
        [who],
      );
    }
    if (aec) {
      await tx.unsafe(
        `insert into public.account_external_credentials (user_id, apple_refresh_token_encrypted, apple_token_captured_at) values ($1::uuid, repeat('😀', 8192), now())`,
        [who],
      );
    }
  };
  await seedRows(uid, nConsent, nFeedback, hasAdr, hasAec);
  await seedRows(bystander, 2, 1, true, true);

  const feedbackIds = (
    await tx.unsafe(
      `select array_agg(id::text order by id) as ids from public.account_deletion_feedback where user_id = $1::uuid`,
      [uid],
    )
  )[0].ids as string[] | null;
  const fingerprint = async (ids: string[]) =>
    (
      await tx.unsafe(
        `select md5(string_agg(concat_ws('|', id, reason, wanted, details, provider, platform, app_version, account_age_days, was_premium, scored_count, created_at), '#' order by id)) as h,
                bool_and(user_id is null) as anon, count(*)::int as n
           from public.account_deletion_feedback where id = any($1::uuid[])`,
        [ids],
      )
    )[0];
  const fpBefore = feedbackIds ? await fingerprint(feedbackIds) : null;
  const bystanderState = async () =>
    (
      await tx.unsafe(
        `select (select count(*) from public.profiles where id = $1::uuid)::int as profiles,
                (select count(*) from public.consent_records where user_id = $1::uuid)::int as cr,
                (select count(*) from public.account_deletion_requests where user_id = $1::uuid)::int as adr,
                (select count(*) from public.account_external_credentials where user_id = $1::uuid)::int as aec,
                (select count(*) from public.account_deletion_feedback where user_id = $1::uuid)::int as adf`,
        [bystander],
      )
    )[0];
  const byBefore = JSON.stringify(await bystanderState());

  const res = await attempt(tx, () =>
    tx.unsafe(
      via === "auth.users"
        ? `delete from auth.users where id = $1::uuid`
        : `delete from public.profiles where id = $1::uuid`,
      [uid],
    ),
  );
  const violations: string[] = [];
  if (res.state !== "ok") {
    violations.push(`CASCADE:delete-failed(${res.state})`);
  }
  const left = (
    await tx.unsafe(
      `select (select count(*) from public.profiles where id = $1::uuid)::int as profiles,
              (select count(*) from public.consent_records where user_id = $1::uuid)::int as cr,
              (select count(*) from public.account_deletion_requests where user_id = $1::uuid)::int as adr,
              (select count(*) from public.account_external_credentials where user_id = $1::uuid)::int as aec,
              (select count(*) from public.account_deletion_feedback where user_id = $1::uuid)::int as adf_owned,
              (select count(*) from auth.identities where user_id = $1::uuid)::int as identities`,
      [uid],
    )
  )[0];
  const byAfter = JSON.stringify(await bystanderState());
  if (res.state === "ok") {
    if (via === "auth.users" && left.identities !== 0) {
      violations.push("CASCADE:identities-left");
    }
    if (left.profiles !== 0) violations.push("CASCADE:profile-left");
    if (left.cr !== 0) violations.push("CASCADE:consent-rows-left");
    if (left.adr !== 0) violations.push("CASCADE:deletion-request-left");
    if (left.aec !== 0) violations.push("CASCADE:credentials-left");
    if (left.adf_owned !== 0) violations.push("CASCADE:feedback-still-owned");
    if (byAfter !== byBefore) violations.push("CASCADE:bystander-touched");
    if (feedbackIds && fpBefore) {
      const fpAfter = await fingerprint(feedbackIds);
      if (fpAfter.n !== feedbackIds.length) {
        violations.push("CASCADE:feedback-rows-lost");
      }
      if (fpAfter.h !== fpBefore.h) {
        violations.push("CASCADE:feedback-content-mutated");
      }
      if (!fpAfter.anon) violations.push("CASCADE:feedback-not-anonymised");
    }
  }
  return {
    table: "cascade",
    expected: "accept",
    observed: res.state,
    message: res.message,
    inputs: {
      user: uid,
      bystander,
      via,
      consent_rows: String(nConsent),
      feedback_rows: String(nFeedback),
      deletion_request: String(hasAdr),
      credentials: String(hasAec),
      left: JSON.stringify(left),
      bystander_before: byBefore,
      bystander_after: byAfter,
    },
    violations,
    repro: violations.length ? `-- replay: STRESS_REPLAY=${c.seed}` : undefined,
  };
}

// ─── Parallel scenarios (own connections, committed, cleaned up) ────────────

async function withUser(sql: Sql, uid: string, fn: () => Promise<void>) {
  await sql.unsafe(provisionSql(uid, "google"));
  try {
    await fn();
  } finally {
    // Anonymised feedback rows are append-only by design and stay behind.
    await sql.unsafe(`delete from auth.users where id = $1::uuid`, [uid]);
  }
}

const errState = (e: unknown) => (isPgError(e) && e.code ? e.code : "exception");
const errMsg = (e: unknown) =>
  (isPgError(e) ? `${e.code ?? ""} ${e.message}` : String(e)).slice(0, 160);

/** K concurrent PostgREST-shaped upserts for one user → exactly one row. */
async function caseParallelUpsert(c: Ctx): Promise<Verdict> {
  const { rng, sql } = c;
  const uid = randomUuid(rng);
  const k = int(rng, 2, 8);
  const isolation = pick(rng, ["read committed", "read committed", "serializable"]);
  const challenges = Array.from({ length: k }, () => randomUuid(rng));
  const delays = Array.from({ length: k }, () => int(rng, 0, 20));
  const outcomes: string[] = new Array(k).fill("");
  const messages: string[] = [];
  let rowsAfter = -1;
  let finalChallenge = "";
  await withUser(sql, uid, async () => {
    await Promise.all(
      challenges.map(async (ch, i) => {
        try {
          await sql.begin(async (tx: Tx) => {
            await tx.unsafe(`set transaction isolation level ${isolation}`);
            await tx.unsafe(asUser(uid));
            await tx.unsafe(`select pg_sleep(${delays[i] / 1000})`);
            await tx.unsafe(
              `insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
               values ($1::uuid, $2::uuid, now(), now() + interval '15 minutes')
               on conflict (user_id) do update set user_id = excluded.user_id, challenge = excluded.challenge, created_at = excluded.created_at, expires_at = excluded.expires_at`,
              [uid, ch],
            );
          });
          outcomes[i] = "ok";
        } catch (e) {
          outcomes[i] = errState(e);
          messages.push(errMsg(e));
        }
      }),
    );
    const r = await sql.unsafe(
      `select count(*)::int as n, min(challenge::text) as ch from public.account_deletion_requests where user_id = $1::uuid`,
      [uid],
    );
    rowsAfter = r[0].n;
    finalChallenge = r[0].ch ?? "";
  });
  const violations: string[] = [];
  const okCount = outcomes.filter((o) => o === "ok").length;
  for (const o of outcomes) {
    if (o !== "ok" && !GRACEFUL.test(o) && !(isolation === "serializable" && RETRYABLE.test(o))) {
      violations.push(`I1:untyped-error(${o})`);
    }
    if (isolation === "read committed" && o !== "ok") {
      violations.push(`PARALLEL:read-committed-upsert-failed(${o})`);
    }
  }
  if (okCount === 0) violations.push("PARALLEL:no-writer-succeeded");
  if (rowsAfter !== 1) violations.push(`PARALLEL:row-count=${rowsAfter}`);
  if (!challenges.includes(finalChallenge)) {
    violations.push("PARALLEL:unknown-final-challenge");
  }
  return {
    table: "account_deletion_requests",
    expected: "accept",
    observed: outcomes.join(","),
    message: messages.join(" / ") || undefined,
    inputs: {
      user: uid,
      sessions: String(k),
      isolation,
      delays_ms: delays.join(","),
    },
    violations,
    repro: violations.length ? `-- replay: STRESS_REPLAY=${c.seed}` : undefined,
  };
}

/** Client writes racing the account deletion. */
async function caseParallelDeleteRace(c: Ctx): Promise<Verdict> {
  const { rng, sql } = c;
  const uid = randomUuid(rng);
  const writers = int(rng, 1, 4);
  const deleteDelay = int(rng, 0, 15);
  const writerDelays = Array.from({ length: writers }, () => int(rng, 0, 15));
  const writerKinds = Array.from({ length: writers }, () =>
    pick(rng, ["consent", "feedback", "request"]),
  );
  // Anonymised feedback rows outlive the iteration (append-only), so ids must
  // not repeat across campaigns on the same database.
  const feedbackIds = writerKinds.map(() => crypto.randomUUID());
  const outcomes: string[] = new Array(writers).fill("");
  const messages: string[] = [];
  let left: Record<string, number> = {};
  let deleteState = "";
  const committedFeedback: string[] = [];
  await withUser(sql, uid, async () => {
    const jobs = writerKinds.map(async (kind, i) => {
      try {
        await sql.begin(async (tx: Tx) => {
          await tx.unsafe(asUser(uid));
          if (kind === "consent") {
            await tx.unsafe(
              `insert into public.consent_records (user_id, scope, action, consent_version) values ($1::uuid, 'model_training', 'grant', 'v1')`,
              [uid],
            );
          } else if (kind === "feedback") {
            await tx.unsafe(
              `insert into public.account_deletion_feedback (id, user_id, reason, details) values ($1::uuid, $2::uuid, 'other', $3::text)`,
              [feedbackIds[i], uid, `stress:${uid}:${i}`],
            );
          } else {
            await tx.unsafe(
              `insert into public.account_deletion_requests (user_id) values ($1::uuid) on conflict (user_id) do update set challenge = gen_random_uuid()`,
              [uid],
            );
          }
          await tx.unsafe(`select pg_sleep(${writerDelays[i] / 1000})`);
        });
        outcomes[i] = "ok";
        if (kind === "feedback") committedFeedback.push(feedbackIds[i]);
      } catch (e) {
        outcomes[i] = errState(e);
        messages.push(errMsg(e));
      }
    });
    jobs.push(
      (async () => {
        await new Promise((r) => setTimeout(r, deleteDelay));
        try {
          await sql.unsafe(`delete from auth.users where id = $1::uuid`, [uid]);
          deleteState = "ok";
        } catch (e) {
          deleteState = errState(e);
          messages.push(errMsg(e));
        }
      })(),
    );
    await Promise.all(jobs);
    left = (
      await sql.unsafe(
        `select (select count(*) from public.profiles where id = $1::uuid)::int as profiles,
                (select count(*) from public.consent_records where user_id = $1::uuid)::int as cr,
                (select count(*) from public.account_deletion_requests where user_id = $1::uuid)::int as adr,
                (select count(*) from public.account_deletion_feedback where user_id = $1::uuid)::int as adf_owned,
                (select count(*) from public.account_deletion_feedback where id = any($2::uuid[]) and user_id is null)::int as adf_anon`,
        [uid, committedFeedback],
      )
    )[0];
  });
  const violations: string[] = [];
  if (deleteState !== "ok") {
    violations.push(`PARALLEL:user-delete-failed(${deleteState})`);
  }
  for (const o of outcomes) {
    // 23503 = profile already gone when the FK was checked.
    if (o !== "ok" && o !== "23503") {
      violations.push(`PARALLEL:writer-error(${o})`);
    }
  }
  if (left.profiles !== 0) violations.push("PARALLEL:profile-left");
  if (left.cr !== 0) violations.push("PARALLEL:orphan-consent-rows");
  if (left.adr !== 0) violations.push("PARALLEL:orphan-deletion-request");
  if (left.adf_owned !== 0) violations.push("PARALLEL:feedback-still-owned");
  if (left.adf_anon !== committedFeedback.length) {
    violations.push("PARALLEL:committed-feedback-lost");
  }
  return {
    table: "cascade",
    expected: "accept",
    observed: `writers=${outcomes.join(",")};delete=${deleteState}`,
    message: messages.join(" / ") || undefined,
    inputs: {
      user: uid,
      writers: writerKinds.join(","),
      writer_delays_ms: writerDelays.join(","),
      delete_delay_ms: String(deleteDelay),
      left: JSON.stringify(left),
    },
    violations,
    repro: violations.length ? `-- replay: STRESS_REPLAY=${c.seed}` : undefined,
  };
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

type TxCase = (c: Ctx, tx: Tx) => Promise<Verdict>;
type ConnCase = (c: Ctx) => Promise<Verdict>;

const TX_SCENARIOS: Array<[string, number, TxCase]> = [
  ["consent_insert", 22, caseConsentInsert],
  ["feedback_insert", 22, caseFeedbackInsert],
  ["deletion_request_upsert", 14, caseDeletionRequestUpsert],
  ["credentials_service_write", 7, caseCredentialsServiceWrite],
  ["credentials_client_probe", 6, caseCredentialsClientProbe],
  ["cross_user", 9, caseCrossUser],
  ["ledger_mutation", 6, caseLedgerMutation],
  ["cascade", 7, caseCascade],
];
const CONN_SCENARIOS: Array<[string, number, ConnCase]> = [
  ["parallel_upsert", 4, caseParallelUpsert],
  ["parallel_delete_race", 3, caseParallelDeleteRace],
];
const TOTAL_WEIGHT = [...TX_SCENARIOS, ...CONN_SCENARIOS].reduce((a, [, w]) => a + w, 0);

function pickScenario(rng: Rng): { name: string; tx?: TxCase; conn?: ConnCase } {
  let r = rng() * TOTAL_WEIGHT;
  for (const [name, w, fn] of TX_SCENARIOS) {
    if (r < w) return { name, tx: fn };
    r -= w;
  }
  for (const [name, w, fn] of CONN_SCENARIOS) {
    if (r < w) return { name, conn: fn };
    r -= w;
  }
  return { name: TX_SCENARIOS[0][0], tx: TX_SCENARIOS[0][2] };
}

class RollbackSignal extends Error {}

export async function runCase(sql: Sql, seed: number, index: number): Promise<CaseResult> {
  const rng = mulberry32(seed);
  const scenario = pickScenario(rng);
  const ctx: Ctx = { sql, seed, index, rng };
  const started = performance.now();
  let verdict: Verdict;
  try {
    if (scenario.tx) {
      const fn = scenario.tx;
      let inner: Verdict | undefined;
      // Everything runs in one transaction that is always rolled back.
      await sql
        .begin(async (tx: Tx) => {
          inner = await fn(ctx, tx);
          // I5: connection survives the payload.
          await tx.unsafe(asOwner);
          const alive = await tx.unsafe(`select 1 as one`);
          if (alive[0].one !== 1) {
            inner.violations.push("I5:connection-unhealthy");
          }
          throw new RollbackSignal();
        })
        .catch((e: unknown) => {
          if (!(e instanceof RollbackSignal)) throw e;
        });
      verdict = inner!;
    } else {
      verdict = await scenario.conn!(ctx);
    }
  } catch (e) {
    verdict = {
      table: "harness",
      expected: "n/a",
      observed: "exception",
      message: errMsg(e),
      inputs: {},
      violations: ["I1:exception-escaped-case"],
    };
  }
  return {
    seed,
    index,
    scenario: scenario.name,
    table: verdict.table,
    outcome: verdict.violations.length === 0 ? "HELD" : "BROKEN",
    expected: verdict.expected,
    observed: verdict.observed,
    message: verdict.message,
    inputs: verdict.inputs,
    violations: verdict.violations,
    repro: verdict.repro,
    ms: Math.round(performance.now() - started),
  };
}

export interface CampaignOptions {
  pgUrl: string;
  iterations: number;
  seed: number;
  concurrency?: number;
  replaySeed?: number;
  onProgress?: (done: number, broken: number) => void;
}

export async function runCampaign(
  opts: CampaignOptions,
): Promise<{ results: CaseResult[]; summary: CampaignSummary }> {
  const concurrency = opts.concurrency ?? 8;
  // Parallel scenarios open up to 9 sessions each; keep headroom below PG's
  // default max_connections=100.
  const sql = postgres(opts.pgUrl, {
    max: Math.min(90, concurrency * 10),
    onnotice: () => {},
  });
  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];
  try {
    const pgVersion = (await sql.unsafe(`show server_version`))[0].server_version as string;
    const seeds: Array<[number, number]> =
      opts.replaySeed !== undefined
        ? [[opts.replaySeed, 0]]
        : Array.from({ length: opts.iterations }, (_, i) => [iterationSeed(opts.seed, i), i]);
    let next = 0;
    let broken = 0;
    const worker = async () => {
      while (next < seeds.length) {
        const [seed, index] = seeds[next++];
        const r = await runCase(sql, seed, index);
        results.push(r);
        if (r.outcome === "BROKEN") broken++;
        opts.onProgress?.(results.length, broken);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    results.sort((a, b) => a.index - b.index);
    const byScenario: CampaignSummary["byScenario"] = {};
    const bySqlstate: Record<string, number> = {};
    for (const r of results) {
      byScenario[r.scenario] ??= { executed: 0, broken: 0 };
      byScenario[r.scenario].executed++;
      if (r.outcome === "BROKEN") byScenario[r.scenario].broken++;
      for (const st of r.observed.split(/[,;]/)) {
        const key = st.replace(/^writers=|^delete=/, "");
        bySqlstate[key] = (bySqlstate[key] ?? 0) + 1;
      }
    }
    const summary: CampaignSummary = {
      campaignSeed: opts.seed,
      iterations: seeds.length,
      executed: results.length,
      held: results.filter((r) => r.outcome === "HELD").length,
      broken,
      byScenario,
      bySqlstate,
      brokenSeeds: results.filter((r) => r.outcome === "BROKEN").map((r) => r.seed),
      startedAt,
      finishedAt: new Date().toISOString(),
      pgVersion,
    };
    return { results, summary };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  const pgUrl = Deno.env.get("PICKLE_STRESS_PG_URL") ?? "";
  if (!pgUrl) {
    console.error(
      "PICKLE_STRESS_PG_URL is required (postgres://postgres:x@127.0.0.1:5499/postgres)",
    );
    Deno.exit(2);
  }
  const iterations = Number(Deno.env.get("STRESS_ITER") ?? "300");
  const seed = Number(Deno.env.get("STRESS_SEED") ?? "20260904");
  const replay = Deno.env.get("STRESS_REPLAY");
  const out = Deno.env.get("STRESS_OUT") ?? "";
  const concurrency = Number(Deno.env.get("STRESS_CONCURRENCY") ?? "8");
  let lastLog = 0;
  const { results, summary } = await runCampaign({
    pgUrl,
    iterations,
    seed,
    concurrency,
    replaySeed: replay ? Number(replay) : undefined,
    onProgress: (done, broken) => {
      if (done - lastLog >= 250 || done === iterations) {
        lastLog = done;
        console.error(`[stress] ${done}/${iterations} broken=${broken}`);
      }
    },
  });
  if (out) {
    await Deno.writeTextFile(out, JSON.stringify({ summary, results }, null, 1));
    console.error(`[stress] results → ${out}`);
  }
  console.log(JSON.stringify(summary, null, 2));
  if (replay) console.log(JSON.stringify(results, null, 2));
  Deno.exit(summary.broken === 0 ? 0 : 1);
}
