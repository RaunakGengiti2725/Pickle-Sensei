/**
 * stress · db-apply-synced-shot · lens `boundary-malformed`
 *
 * Drives the REAL public.apply_synced_shot(jsonb) (+ enforce_scored_shot_permit
 * and the shots / shot_phases / shot_checkpoints / shot_measurements tables)
 * on a disposable postgres:16 with shim_auth.sql + every migration applied
 * (./stress_pg_up.sh) using N independent connections, each iteration in its
 * own transaction as role `authenticated` with the caller's JWT sub (or
 * `anon` / no-sub / service_role), fed by a seeded generator of malformed and
 * boundary payloads (boundary_malformed_gen.ts). Every iteration is rolled
 * back, so the campaign never mutates the fixture and every seed replays.
 *
 *   ./stress_pg_up.sh                                  # prints STRESS_PG_URL
 *   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres \
 *     deno test -A --no-check --config deno.json boundary_malformed_apply_synced_shot.test.ts
 *
 *   STRESS_ITER=3000 STRESS_LANES=8 ...                # full campaign (default 150)
 *   STRESS_SEED=<n>                                    # campaign seed (default 20260904)
 *   STRESS_REPLAY=<iterSeed>[,<iterSeed>...]           # replay exact iterations
 *   STRESS_OUT_DIR=/tmp/stress-boundary                # results.json, summary.json, ...
 *   STRESS_REPEAT=10                                   # re-run each failing seed N× (flake rate)
 *
 * Without STRESS_PG_URL (aliases: XC_PG_URL, PICKLE_AUDIT_PG_URL) the test is
 * `ignore`d — an ignored run is NOT a pass.
 *
 * INVARIANTS (each violation is one entry in `violations`):
 *   RAISE_ESCAPED     the RPC raised (any SQLSTATE) for a payload that IS
 *                     valid jsonb — the contract is a typed text verdict, never
 *                     a throw; the only tolerated raise is 42501 for a role
 *                     without EXECUTE (anon / service_role → grant layer).
 *   RESULT_UNKNOWN    verdict text outside the documented set.
 *   WRITE_ON_REJECT   a non-`accepted` verdict left rows in shots / phases /
 *                     checkpoints / measurements, or moved a permit other
 *                     than the two documented releases (expired, paywall).
 *   PERMIT_DRIFT      the permit transition does not match the verdict.
 *   ROW_UNSANE        an accepted row violates a documented shape rule
 *                     (owner ≠ caller, NaN/Infinity stored, > 64-char text,
 *                     detail rows not owned by the caller, low_confidence
 *                     with a score, scored without one).
 *   RAISE_MESSAGE_ECHO a tolerated/untolerated raise's message echoes the
 *                     client payload (detail leak).
 *   CONN_DEAD         the lane's connection could not `select 1` afterwards.
 *   SLOW              a single call took > STRESS_SLOW_MS (default 5000).
 *
 * jsonb-cast rejections (`select $1::text::jsonb` raising 22P02/22P05/22P03/
 * 54001/22021) are recorded as outcome `jsonb_cast_rejected:<sqlstate>` — the
 * function is never entered, nothing can be written; they are HELD, not
 * violations, and are counted separately in summary.json.
 */
import postgres from "postgres";
import { assert } from "@std/assert";
import {
  type Fixture,
  type FixtureUser,
  generate,
  iterSeed,
  type Scenario,
} from "./boundary_malformed_gen.ts";

const PG_URL =
  Deno.env.get("STRESS_PG_URL") ??
  Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ??
  "";
const ignore = PG_URL === "";

function envInt(name: string, dflt: number): number {
  const v = Deno.env.get(name);
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0)
    throw new Error(`${name} must be a non-negative number, got ${v}`);
  return Math.floor(n);
}

const ITER = envInt("STRESS_ITER", 150);
const SEED = envInt("STRESS_SEED", 20260904);
const LANES = Math.max(1, envInt("STRESS_LANES", 8));
const SLOW_MS = envInt("STRESS_SLOW_MS", 5000);
const REPEAT = envInt("STRESS_REPEAT", 10);
const OUT_DIR = Deno.env.get("STRESS_OUT_DIR") ?? "/tmp/stress-boundary";
const REPLAY = (Deno.env.get("STRESS_REPLAY") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s));

type Sql = ReturnType<typeof postgres>;
type Reserved = Awaited<ReturnType<Sql["reserve"]>>;

const KNOWN_RESULTS = new Set([
  "accepted",
  "auth.required",
  "access.permit_not_found",
  "access.permit_not_reserved",
  "access.permit_expired",
  "access.paywall_required",
  "shot.session_not_found",
  "shot.id_conflict",
]);
const WRITE_FAILED_RE = /^shot\.write_failed:[0-9A-Z]{5}$/;
const CAST_REJECT_STATES = new Set([
  "22P02",
  "22P05",
  "22P03",
  "22003",
  "54001",
  "22021",
  "22P06",
  "22P04",
]);

// ------------------------------------------------------------ fixture ----

const FX_IDS = {
  alice: "0a11ce00-0000-4000-8000-00000000a11c",
  bob: "0b0b0000-0000-4000-8000-000000000b0b",
  carol: "0ca10100-0000-4000-8000-0000000ca101",
  dave: "0da7e000-0000-4000-8000-00000000da7e",
} as const;

async function createUser(sql: Sql, name: FixtureUser["name"]): Promise<void> {
  const id = FX_IDS[name];
  const sub = `stress-boundary-${name}`;
  await sql.unsafe(`delete from auth.users where id = '${id}'`);
  await sql.unsafe(
    `delete from auth.users u using auth.identities i
      where i.user_id = u.id and i.provider = 'google' and i.provider_id = '${sub}'`,
  );
  await sql.unsafe(
    `delete from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('google', '${sub}')`,
  );
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${id}', '${sub}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', '${sub}', '${id}', '{"sub":"${sub}"}')`,
  );
}

async function ownerInsertShot(
  sql: Sql,
  userId: string,
  shotId: string,
  scored: boolean,
): Promise<void> {
  await sql.unsafe(
    `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
       overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
       paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
     values ('${shotId}', '${userId}', 'dink', 'side', '2026-08-01T10:00:00Z', 0, 100, 200,
       ${scored ? "6.5" : "null"}, ${scored ? "0.9" : "0.3"}, '${scored ? "scored" : "low_confidence"}',
       '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1', 'real')`,
  );
}

async function ownerPermit(
  sql: Sql,
  userId: string,
  key: string,
  status: "reserved" | "finalized",
  outcome: string | null,
  ageHours: number,
): Promise<string> {
  const r = await sql.unsafe(
    `insert into public.analysis_permits (user_id, idempotency_key, status, outcome, created_at)
     values ('${userId}', '${key}', '${status}', ${outcome ? `'${outcome}'` : "null"}, now() - interval '${ageHours} hours')
     returning id::text as id`,
  );
  return String(r[0].id);
}

async function setupFixture(sql: Sql): Promise<Fixture> {
  const users = {} as Fixture["users"];
  const plan: Array<{ name: FixtureUser["name"]; premium: boolean; scored: number }> = [
    { name: "alice", premium: false, scored: 0 },
    { name: "bob", premium: false, scored: 1 },
    { name: "carol", premium: true, scored: 0 },
    { name: "dave", premium: false, scored: 2 },
  ];
  for (const p of plan) {
    const id = FX_IDS[p.name];
    await createUser(sql, p.name);
    if (p.premium) {
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, product_key) values ('${id}', true, 'pickle_sensei_pro')
         on conflict (user_id) do update set premium = true, expires_at = null`,
      );
    }
    const sess = await sql.unsafe(
      `insert into public.sessions (id, user_id, started_at) values ('4${id.slice(1)}', '${id}', now() - interval '1 hour') returning id::text as id`,
    );
    const ownedShotId = `5${id.slice(1)}`;
    await ownerInsertShot(sql, id, ownedShotId, false);
    for (let i = 0; i < p.scored; i++) {
      await ownerInsertShot(sql, id, `${(6 + i).toString(16)}${id.slice(1)}`, true);
    }
    const livePermit = await ownerPermit(sql, id, `stress-live-${p.name}`, "reserved", null, 0);
    const expiredPermit = await ownerPermit(
      sql,
      id,
      `stress-expired-${p.name}`,
      "reserved",
      null,
      25,
    );
    const spentPermit = await ownerPermit(
      sql,
      id,
      `stress-spent-${p.name}`,
      "finalized",
      "scored",
      1,
    );
    users[p.name] = {
      name: p.name,
      id,
      livePermit,
      expiredPermit,
      spentPermit,
      sessionId: String(sess[0].id),
      ownedShotId,
      premium: p.premium,
      scoredBefore: p.scored,
    };
  }
  return { users };
}

// ------------------------------------------------------------- probes ----

interface PermitState {
  id: string;
  status: string;
  outcome: string | null;
}

interface Counts {
  shots: number;
  phases: number;
  checkpoints: number;
  measurements: number;
  ledgerSum: number;
}

const FX_USER_LIST = `('${Object.values(FX_IDS).join("','")}')`;

async function counts(c: Reserved): Promise<Counts> {
  const r = await c.unsafe(
    `select
       (select count(*) from public.shots where user_id in ${FX_USER_LIST})::int as shots,
       (select count(*) from public.shot_phases where user_id in ${FX_USER_LIST})::int as phases,
       (select count(*) from public.shot_checkpoints where user_id in ${FX_USER_LIST})::int as checkpoints,
       (select count(*) from public.shot_measurements where user_id in ${FX_USER_LIST})::int as measurements,
       (select coalesce(sum(l.scored_count), 0) from public.free_rating_ledger l
          join auth.identities i on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
         where i.user_id in ${FX_USER_LIST})::int as ledger`,
  );
  return {
    shots: Number(r[0].shots),
    phases: Number(r[0].phases),
    checkpoints: Number(r[0].checkpoints),
    measurements: Number(r[0].measurements),
    ledgerSum: Number(r[0].ledger),
  };
}

async function permits(c: Reserved): Promise<PermitState[]> {
  const r = await c.unsafe(
    `select id::text as id, status, outcome from public.analysis_permits where user_id in ${FX_USER_LIST} order by id`,
  );
  return r.map((p) => ({
    id: String(p.id),
    status: String(p.status),
    outcome: p.outcome === null ? null : String(p.outcome),
  }));
}

function permitDiff(
  before: PermitState[],
  after: PermitState[],
): Array<{ id: string; from: string; to: string }> {
  const b = new Map(before.map((p) => [p.id, `${p.status}/${p.outcome ?? ""}`]));
  const out: Array<{ id: string; from: string; to: string }> = [];
  for (const p of after) {
    const to = `${p.status}/${p.outcome ?? ""}`;
    const from = b.get(p.id);
    if (from === undefined) out.push({ id: p.id, from: "<new>", to });
    else if (from !== to) out.push({ id: p.id, from, to });
  }
  if (after.length !== before.length)
    out.push({ id: "<count>", from: String(before.length), to: String(after.length) });
  return out;
}

interface PgErr {
  code: string;
  message: string;
}

function asPgErr(e: unknown): PgErr {
  const err = e as { code?: unknown; message?: unknown };
  return {
    code: typeof err.code === "string" ? err.code : "?????",
    message: typeof err.message === "string" ? err.message : String(e),
  };
}

// ---------------------------------------------------------- iteration ----

export interface IterationRow {
  iteration: number;
  seed: number;
  user: string;
  role: string;
  textClass: string;
  permit: string;
  id: string;
  session: string;
  resultKind: string;
  mutations: string[];
  textBytes: number;
  textSha: string;
  /** the payload text (elided in the middle beyond 2 KB so results.json stays readable; replay from the seed) */
  textPreview: string;
  outcome: string;
  raise: PgErr | null;
  rpcMs: number;
  writes: Partial<Counts> | null;
  permitDiff: Array<{ id: string; from: string; to: string }>;
  /** a FRESH row was written although ≥1 mutation was applied — the DB tolerated the poison (review table, not a violation) */
  lenientAccept: boolean;
  /** owner-eye snapshot of the freshly written shot row (accepted + write only) */
  storedRow: Record<string, unknown> | null;
  violations: string[];
}

function preview(text: string): string {
  if (text.length <= 2048) return text;
  return `${text.slice(0, 1024)}…[${text.length - 2048} chars elided]…${text.slice(-1024)}`;
}

async function runIteration(
  c: Reserved,
  fx: Fixture,
  iteration: number,
  seed: number,
  baseCounts: Counts,
  basePermits: PermitState[],
): Promise<IterationRow> {
  const sc: Scenario = generate(seed, fx);
  const user = fx.users[sc.user];
  const row: IterationRow = {
    iteration,
    seed,
    user: sc.user,
    role: sc.role,
    textClass: sc.textClass,
    permit: sc.permit,
    id: sc.id,
    session: sc.session,
    resultKind: sc.resultKind,
    mutations: sc.mutations.map((m) => `${m.path} ← ${m.poison}`),
    textBytes: sc.textBytes,
    textSha: sc.textSha,
    textPreview: preview(sc.text),
    outcome: "",
    raise: null,
    rpcMs: 0,
    writes: null,
    permitDiff: [],
    lenientAccept: false,
    storedRow: null,
    violations: [],
  };

  await c.unsafe("begin");
  try {
    // 1. Does the text even parse as jsonb? (This is what PostgREST / the
    //    edge fn's supabase-js rpc() would hit before the function runs.)
    await c.unsafe("savepoint cast_probe");
    let castOk = true;
    try {
      await c.unsafe("select $1::text::jsonb as j", [sc.text]);
    } catch (e) {
      castOk = false;
      const err = asPgErr(e);
      await c.unsafe("rollback to savepoint cast_probe");
      row.outcome = `jsonb_cast_rejected:${err.code}`;
      row.raise = err;
      if (!CAST_REJECT_STATES.has(err.code))
        row.violations.push(`CAST_UNEXPECTED_STATE:${err.code}`);
    }

    if (castOk) {
      // 2. Caller context.
      if (sc.role === "authenticated") {
        await c.unsafe("set local role authenticated");
        await c.unsafe(`set local request.jwt.claim.sub = '${user.id}'`);
      } else if (sc.role === "authenticated-no-sub") {
        await c.unsafe("set local role authenticated");
      } else if (sc.role === "anon") {
        await c.unsafe("set local role anon");
      } else {
        await c.unsafe("set local role service_role");
      }

      // 3. The call.
      await c.unsafe("savepoint rpc_call");
      const t0 = performance.now();
      try {
        const r = await c.unsafe("select public.apply_synced_shot($1::text::jsonb) as result", [
          sc.text,
        ]);
        row.rpcMs = Math.round((performance.now() - t0) * 100) / 100;
        row.outcome = String(r[0].result);
      } catch (e) {
        row.rpcMs = Math.round((performance.now() - t0) * 100) / 100;
        const err = asPgErr(e);
        row.raise = err;
        row.outcome = `raised:${err.code}`;
        await c.unsafe("rollback to savepoint rpc_call");
        const tolerated =
          err.code === "42501" && (sc.role === "anon" || sc.role === "service_role");
        if (!tolerated) row.violations.push(`RAISE_ESCAPED:${err.code}`);
        // A raise whose message quotes a value taken from the client's
        // payload is a detail leak on the wire (PostgREST forwards `message`).
        const quoted = err.message.match(/: "([^"]*)"/);
        if (quoted && quoted[1].length > 0 && sc.text.includes(quoted[1])) {
          row.violations.push("RAISE_MESSAGE_ECHO");
        }
      }
      if (row.rpcMs > SLOW_MS) row.violations.push(`SLOW:${row.rpcMs}ms`);

      // 4. Verdict shape.
      if (
        row.raise === null &&
        !KNOWN_RESULTS.has(row.outcome) &&
        !WRITE_FAILED_RE.test(row.outcome)
      ) {
        row.violations.push(`RESULT_UNKNOWN:${row.outcome}`);
      }

      // 5. Owner-eye post-state (same transaction, so uncommitted effects are visible).
      await c.unsafe("reset role");
      const after = await counts(c);
      const delta: Partial<Counts> = {};
      for (const k of Object.keys(after) as Array<keyof Counts>) {
        if (after[k] !== baseCounts[k]) delta[k] = after[k] - baseCounts[k];
      }
      row.writes = Object.keys(delta).length ? delta : null;
      row.permitDiff = permitDiff(basePermits, await permits(c));

      const accepted = row.outcome === "accepted";
      if (!accepted) {
        if (row.writes) row.violations.push(`WRITE_ON_REJECT:${JSON.stringify(row.writes)}`);
        if (row.outcome === "access.permit_expired") {
          const ok =
            row.permitDiff.length === 1 &&
            row.permitDiff[0].id === user.expiredPermit &&
            row.permitDiff[0].to === "released/expired";
          if (!ok) row.violations.push(`PERMIT_DRIFT:${JSON.stringify(row.permitDiff)}`);
        } else if (row.outcome === "access.paywall_required") {
          const ok =
            row.permitDiff.length === 1 &&
            row.permitDiff[0].id === user.livePermit &&
            row.permitDiff[0].to === "released/free_limit_exceeded";
          if (!ok) row.violations.push(`PERMIT_DRIFT:${JSON.stringify(row.permitDiff)}`);
        } else if (row.permitDiff.length) {
          row.violations.push(`PERMIT_DRIFT:${JSON.stringify(row.permitDiff)}`);
        }
      } else {
        if (!row.writes) {
          // replay of an owned id: nothing may move
          if (row.permitDiff.length)
            row.violations.push(`PERMIT_DRIFT:${JSON.stringify(row.permitDiff)}`);
        } else {
          // a fresh row landed — check its shape and ownership
          if ((row.writes.shots ?? 0) !== 1)
            row.violations.push(`ROW_UNSANE:shots_delta=${row.writes.shots}`);
          const shot = await c.unsafe(
            `select s.id::text as id, s.user_id::text as user_id, s.result_kind, s.overall_score::text as overall_score,
                    s.analysis_confidence::text as analysis_confidence, isfinite(s.captured_at) as finite_captured,
                    s.overall_score = 'NaN'::numeric as score_nan, s.analysis_confidence = 'NaN'::numeric as conf_nan,
                    greatest(length(s.shot_type), length(s.app_version), length(s.model_bundle_version), length(s.pose_model_version),
                             length(s.paddle_model_version), length(s.stroke_detector_version), length(s.phase_model_version),
                             length(s.scoring_model_version), length(s.shot_config_version)) as max_text_len,
                    s.camera_view, s.source, s.session_id::text as session_id, s.shot_type, s.start_ms, s.contact_ms, s.end_ms,
                    s.captured_at::text as captured_at,
                    (select count(*) from public.shot_phases p where p.shot_id = s.id)::int as n_phases,
                    (select count(*) from public.shot_checkpoints k where k.shot_id = s.id)::int as n_cps,
                    (select count(*) from public.shot_phases p where p.shot_id = s.id and (p.user_id <> s.user_id))::int as foreign_phases,
                    (select count(*) from public.shot_checkpoints k where k.shot_id = s.id and (k.user_id <> s.user_id))::int as foreign_cps,
                    (select count(*) from public.shot_phases p where p.shot_id = s.id and (p.confidence = 'NaN'::numeric or length(p.phase_key) > 64))::int as bad_phases,
                    (select count(*) from public.shot_checkpoints k where k.shot_id = s.id and (
                        k.confidence = 'NaN'::numeric or k.score = 'NaN'::numeric or k.severity = 'NaN'::numeric
                        or length(k.checkpoint_key) > 64 or length(k.direction) > 64))::int as bad_cps
               from public.shots s
              where s.user_id in ${FX_USER_LIST}
                and s.id not in (select unnest($1::uuid[]))`,
            [
              Object.values(fx.users).flatMap((u) => [
                u.ownedShotId,
                `6${u.id.slice(1)}`,
                `7${u.id.slice(1)}`,
              ]),
            ],
          );
          if (shot.length !== 1) {
            row.violations.push(`ROW_UNSANE:new_rows=${shot.length}`);
          } else {
            const s = shot[0];
            if (sc.mutations.length > 0) row.lenientAccept = true;
            row.storedRow = {
              id: s.id,
              result_kind: s.result_kind,
              overall_score: s.overall_score,
              analysis_confidence: s.analysis_confidence,
              shot_type: s.shot_type,
              start_ms: s.start_ms,
              contact_ms: s.contact_ms,
              end_ms: s.end_ms,
              captured_at: s.captured_at,
              phases: Number(s.n_phases),
              checkpoints: Number(s.n_cps),
            };
            const expectUid = sc.role === "authenticated" ? user.id : null;
            if (expectUid === null)
              row.violations.push(`ROW_UNSANE:write_without_sub role=${sc.role}`);
            else if (String(s.user_id) !== expectUid)
              row.violations.push(`ROW_UNSANE:owner=${s.user_id}`);
            if (s.finite_captured !== true) row.violations.push("ROW_UNSANE:captured_at_infinite");
            if (s.score_nan === true || s.conf_nan === true)
              row.violations.push("ROW_UNSANE:nan_stored");
            if (Number(s.max_text_len) > 64)
              row.violations.push(`ROW_UNSANE:text_len=${s.max_text_len}`);
            if (s.result_kind === "scored" && s.overall_score === null)
              row.violations.push("ROW_UNSANE:scored_without_score");
            if (s.result_kind === "low_confidence" && s.overall_score !== null)
              row.violations.push("ROW_UNSANE:lowconf_with_score");
            if (s.result_kind !== "scored" && s.result_kind !== "low_confidence")
              row.violations.push(`ROW_UNSANE:result_kind=${s.result_kind}`);
            if (s.source !== "real") row.violations.push(`ROW_UNSANE:source=${s.source}`);
            if (Number(s.foreign_phases) || Number(s.foreign_cps))
              row.violations.push("ROW_UNSANE:detail_rows_foreign_owner");
            if (Number(s.bad_phases) || Number(s.bad_cps))
              row.violations.push("ROW_UNSANE:detail_rows_bad_values");
            if (s.session_id !== null && s.session_id !== user.sessionId)
              row.violations.push(`ROW_UNSANE:session=${s.session_id}`);
            if (sc.role === "authenticated") {
              const expectPermit =
                s.result_kind === "scored" ? "finalized/scored" : "released/low_confidence";
              const ok =
                row.permitDiff.length === 1 &&
                row.permitDiff[0].id === user.livePermit &&
                row.permitDiff[0].to === expectPermit;
              if (!ok)
                row.violations.push(
                  `PERMIT_DRIFT:${JSON.stringify(row.permitDiff)} (accepted ${s.result_kind})`,
                );
              // free-rating ledger must move by exactly 1 for a scored row of a non-premium user, else 0
              const ledgerDelta = row.writes.ledgerSum ?? 0;
              const expectLedger = s.result_kind === "scored" ? 1 : 0;
              if (ledgerDelta !== expectLedger)
                row.violations.push(
                  `ROW_UNSANE:ledger_delta=${ledgerDelta} expected ${expectLedger}`,
                );
              // lifetime cap: dave (2 scored, free) must never land a third scored row
              if (s.result_kind === "scored" && !user.premium && user.scoredBefore >= 2) {
                row.violations.push("ROW_UNSANE:free_limit_bypassed");
              }
            }
          }
        }
      }
    }
  } finally {
    try {
      await c.unsafe("rollback");
    } catch {
      row.violations.push("CONN_DEAD:rollback");
    }
    try {
      await c.unsafe("select 1");
    } catch {
      row.violations.push("CONN_DEAD:select1");
    }
  }
  return row;
}

// --------------------------------------------------------- minimizer ----

/** Greedy key-deletion minimizer for a raising payload: drop top-level keys
 * (then nested keys) while the same SQLSTATE still escapes. Only for texts
 * that parse as JSON objects. */
async function minimizeRaise(
  c: Reserved,
  fx: Fixture,
  sc: Scenario,
  code: string,
): Promise<{ text: string; steps: number } | null> {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(sc.text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    obj = parsed;
  } catch {
    return null;
  }
  const user = fx.users[sc.user];
  const stillRaises = async (candidate: Record<string, unknown>): Promise<boolean> => {
    await c.unsafe("begin");
    try {
      if (sc.role === "authenticated") {
        await c.unsafe("set local role authenticated");
        await c.unsafe(`set local request.jwt.claim.sub = '${user.id}'`);
      } else if (sc.role === "authenticated-no-sub") await c.unsafe("set local role authenticated");
      else if (sc.role === "anon") await c.unsafe("set local role anon");
      else await c.unsafe("set local role service_role");
      await c.unsafe("select public.apply_synced_shot($1::text::jsonb)", [
        JSON.stringify(candidate),
      ]);
      return false;
    } catch (e) {
      return asPgErr(e).code === code;
    } finally {
      await c.unsafe("rollback");
    }
  };
  let steps = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const k of Object.keys(obj)) {
      const cand = { ...obj };
      delete cand[k];
      steps++;
      if (await stillRaises(cand)) {
        obj = cand;
        changed = true;
      }
    }
    // shrink long string values
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === "string" && v.length > 16) {
        const cand = { ...obj, [k]: v.slice(0, 16) };
        steps++;
        if (await stillRaises(cand)) {
          obj = cand;
          changed = true;
        }
      }
    }
  }
  return { text: JSON.stringify(obj), steps };
}

// ------------------------------------------------------------ campaign ----

interface Summary {
  campaignSeed: number;
  iterationsRequested: number;
  iterationsExecuted: number;
  lanes: number;
  wallMs: number;
  byOutcome: Record<string, number>;
  byTextClass: Record<string, number>;
  byRole: Record<string, number>;
  violationsByKind: Record<string, number>;
  failingSeeds: number[];
  lenientAcceptBySeed: Record<string, string[]>;
  lenientAcceptPoisons: Record<string, number>;
  rpcMs: { p50: number; p95: number; p99: number; max: number };
  flakeRates: Record<string, { runs: number; failed: number }>;
  minimized: Record<string, { text: string; steps: number; code: string }>;
  replayHint: string;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

Deno.test({
  name: "stress/boundary-malformed: apply_synced_shot never throws, never writes on rejection, never stores unsane rows",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await Deno.mkdir(OUT_DIR, { recursive: true });
    const sql = postgres(PG_URL, { max: LANES + 2, prepare: false, onnotice: () => {} });
    try {
      const fx = await setupFixture(sql);
      await Deno.writeTextFile(`${OUT_DIR}/fixture.json`, JSON.stringify(fx, null, 2));

      const probe = await sql.reserve();
      const baseCounts = await counts(probe);
      const basePermits = await permits(probe);
      probe.release();

      const seeds: Array<{ iteration: number; seed: number }> = REPLAY.length
        ? REPLAY.map((s, i) => ({ iteration: -1 - i, seed: s }))
        : Array.from({ length: ITER }, (_, i) => ({ iteration: i, seed: iterSeed(SEED, i) }));

      const rows: IterationRow[] = [];
      let cursor = 0;
      const t0 = performance.now();
      const lanes = Math.min(LANES, Math.max(1, seeds.length));
      await Promise.all(
        Array.from({ length: lanes }, async () => {
          const c = await sql.reserve();
          try {
            while (true) {
              const i = cursor++;
              if (i >= seeds.length) break;
              const { iteration, seed } = seeds[i];
              rows.push(await runIteration(c, fx, iteration, seed, baseCounts, basePermits));
            }
          } finally {
            c.release();
          }
        }),
      );
      const wallMs = Math.round(performance.now() - t0);
      rows.sort((a, b) => a.iteration - b.iteration);

      // Fixture must be untouched: every iteration rolled back.
      const post = await sql.reserve();
      const endCounts = await counts(post);
      const endPermits = permitDiff(basePermits, await permits(post));
      post.release();
      const fixtureDrift =
        JSON.stringify(endCounts) !== JSON.stringify(baseCounts) || endPermits.length > 0;

      const failing = rows.filter((r) => r.violations.length > 0);
      const failingSeeds = [...new Set(failing.map((r) => r.seed))];

      // Flake rate: re-run each failing seed REPEAT× on one lane.
      const flakeRates: Summary["flakeRates"] = {};
      const minimized: Summary["minimized"] = {};
      if (failingSeeds.length > 0 && REPEAT > 0) {
        const c = await sql.reserve();
        try {
          for (const seed of failingSeeds.slice(0, 50)) {
            let failed = 0;
            for (let k = 0; k < REPEAT; k++) {
              const r = await runIteration(c, fx, -1, seed, baseCounts, basePermits);
              if (r.violations.length) failed++;
            }
            flakeRates[String(seed)] = { runs: REPEAT, failed };
            const first = failing.find((r) => r.seed === seed)!;
            if (first.raise && first.violations.some((v) => v.startsWith("RAISE_ESCAPED"))) {
              const m = await minimizeRaise(c, fx, generate(seed, fx), first.raise.code);
              if (m) minimized[String(seed)] = { ...m, code: first.raise.code };
            }
          }
        } finally {
          c.release();
        }
      }

      const count = (pick: (r: IterationRow) => string) =>
        rows.reduce<Record<string, number>>((acc, r) => {
          const k = pick(r);
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {});
      const violationsByKind: Record<string, number> = {};
      for (const r of rows) {
        for (const v of r.violations) {
          const k = v.split(":")[0] + (v.startsWith("RAISE_ESCAPED") ? ":" + v.split(":")[1] : "");
          violationsByKind[k] = (violationsByKind[k] ?? 0) + 1;
        }
      }
      const lenientAcceptBySeed: Record<string, string[]> = {};
      const lenientAcceptPoisons: Record<string, number> = {};
      for (const r of rows) {
        if (!r.lenientAccept) continue;
        lenientAcceptBySeed[String(r.seed)] = r.mutations;
        for (const m of r.mutations) {
          const p = m.split(" ← ")[1] ?? m;
          const key = p.replace(/:\d+\/\d+$/, "").slice(0, 60);
          lenientAcceptPoisons[key] = (lenientAcceptPoisons[key] ?? 0) + 1;
        }
      }
      const ms = rows
        .map((r) => r.rpcMs)
        .filter((x) => x > 0)
        .sort((a, b) => a - b);
      const summary: Summary = {
        campaignSeed: SEED,
        iterationsRequested: seeds.length,
        iterationsExecuted: rows.length,
        lanes,
        wallMs,
        byOutcome: count((r) => r.outcome.replace(/^shot\.write_failed:/, "shot.write_failed:")),
        byTextClass: count((r) => r.textClass),
        byRole: count((r) => r.role),
        violationsByKind,
        failingSeeds,
        lenientAcceptBySeed,
        lenientAcceptPoisons,
        rpcMs: {
          p50: pct(ms, 0.5),
          p95: pct(ms, 0.95),
          p99: pct(ms, 0.99),
          max: ms[ms.length - 1] ?? 0,
        },
        flakeRates,
        minimized,
        replayHint: `STRESS_PG_URL=... STRESS_REPLAY=<seed> deno test -A --no-check --config deno.json boundary_malformed_apply_synced_shot.test.ts`,
      };

      await Deno.writeTextFile(`${OUT_DIR}/results.json`, JSON.stringify(rows, null, 1));
      await Deno.writeTextFile(`${OUT_DIR}/summary.json`, JSON.stringify(summary, null, 2));
      await Deno.writeTextFile(
        `${OUT_DIR}/failing.json`,
        JSON.stringify(
          failing.map((r) => ({
            ...r,
            fullText:
              generate(r.seed, fx).text.length <= 8192 ? generate(r.seed, fx).text : undefined,
          })),
          null,
          1,
        ),
      );
      console.log(
        `[stress/boundary-malformed] executed=${rows.length} lanes=${lanes} wall=${wallMs}ms`,
      );
      console.log(`[stress/boundary-malformed] outcomes=${JSON.stringify(summary.byOutcome)}`);
      console.log(
        `[stress/boundary-malformed] violations=${JSON.stringify(violationsByKind)} failingSeeds=${failingSeeds.length}`,
      );
      console.log(
        `[stress/boundary-malformed] lenientAccepts=${Object.keys(lenientAcceptBySeed).length} rpcMs=${JSON.stringify(summary.rpcMs)}`,
      );
      console.log(
        `[stress/boundary-malformed] artifacts: ${OUT_DIR}/{results,summary,failing,fixture}.json`,
      );

      assert(rows.length === seeds.length, `executed ${rows.length} of ${seeds.length} iterations`);
      assert(
        !fixtureDrift,
        `fixture drifted: counts=${JSON.stringify(endCounts)} permits=${JSON.stringify(endPermits)}`,
      );
      assert(
        failingSeeds.length === 0,
        `${failingSeeds.length} seed(s) violated an invariant: ${JSON.stringify(violationsByKind)} — first: seed=${failing[0]?.seed} ${JSON.stringify(
          failing[0]?.violations,
        )} (${OUT_DIR}/failing.json)`,
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
});
