// db-rls-matrix × boundary-malformed stress harness.
//
// Drives the RLS policies, grants, anon revokes and client RPCs of every
// migration with seeded hostile inputs from TWO authenticated users (plus
// anon / null-sub / malformed-sub actors) over N independent connections, and
// asserts graceful rejection: a typed RPC status or a 4xx-class SQLSTATE,
// never a 5xx-class SQLSTATE (PostgREST maps 08/25/40/53400/54/55/57/58/P0*/XX
// to 500 with the server detail), never a lost connection, never a row written
// by a payload that must be refused, never a row of the OTHER user touched.
//
//   ./supabase/tests/stress/pg_up.sh                        # disposable postgres:16
//   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres \
//     deno run -A --config supabase/tests/stress/deno.json supabase/tests/stress/boundary_malformed.ts
//
// Knobs (all optional):
//   STRESS_ITER=300      generated inputs (campaign: 3000+)
//   STRESS_SEED=20260904 master seed; case i replays from caseSeed(seed, i)
//   STRESS_LANES=8       independent connections driving the generated stream
//   STRESS_ROUNDS=2      committed concurrency rounds (READ COMMITTED, then SERIALIZABLE)
//   STRESS_ROUND_STEPS=8 committed steps per lane per round
//   STRESS_REPLAY=12,99  replay only these case indexes (same STRESS_SEED)
//   STRESS_REPEAT=1      run each replayed case N times (flake rate)
//   STRESS_OUT=<dir>     report directory (default artifacts/stress/db-rls-matrix-boundary-malformed/<seed>)
//   STRESS_SKIP_ROUNDS=1 skip the committed concurrency rounds
//
// Exit 0 when every executed iteration HELD; 1 when any BROKEN; 2 on harness error.
import postgres from "postgres";
import {
  ALICE,
  BOB,
  buildCase,
  CLIENT_TABLES,
  Case,
  caseSeed,
  Fixture,
  INSERTABLE,
  mutateRow,
  Prng,
  UserFixture,
  validRow,
  validShot,
} from "./malformed_inputs.ts";

type Sql = ReturnType<typeof postgres>;
type Reserved = Awaited<ReturnType<Sql["reserve"]>>;

const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const PG_URL = env("STRESS_PG_URL", "");
const ITER = Number(env("STRESS_ITER", "300"));
const SEED = Number(env("STRESS_SEED", "20260904")) >>> 0;
const LANES = Math.max(1, Number(env("STRESS_LANES", "8")));
const ROUNDS = Number(env("STRESS_ROUNDS", "2"));
const ROUND_STEPS = Number(env("STRESS_ROUND_STEPS", "8"));
const REPLAY = env("STRESS_REPLAY", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);
const REPEAT = Math.max(1, Number(env("STRESS_REPEAT", "1")));
const SKIP_ROUNDS = env("STRESS_SKIP_ROUNDS", "") === "1";
const HERE = new URL(".", import.meta.url).pathname;
const REPO = new URL("../../../", import.meta.url).pathname;
const OUT = env("STRESS_OUT", `${REPO}artifacts/stress/db-rls-matrix-boundary-malformed/${SEED}`);

if (!PG_URL) {
  console.error("STRESS_PG_URL is required (run ./supabase/tests/stress/pg_up.sh)");
  Deno.exit(2);
}
if (/supabase\.co|ucqnaiwqwjtgvlduiuib/.test(PG_URL)) {
  console.error("refusing to run against a hosted Supabase project");
  Deno.exit(2);
}

// ───────────────────────────── PostgREST status map ──────────────────────────

/** PostgREST SQLSTATE → HTTP status (docs: references/errors, "PostgreSQL
 * errors"; 54001 and 55000 confirmed against postgrest/postgrest:v11.2.2 by
 * postgrest_probe.sh). */
export function pgrstStatus(code: string, authed: boolean): number {
  const c2 = code.slice(0, 2);
  if (code === "54001") return 413;
  if (c2 === "08") return 503;
  if (c2 === "09") return 500;
  if (c2 === "0L" || c2 === "0P") return 403;
  if (code === "23503" || code === "23505") return 409;
  if (code === "25006") return 405;
  if (c2 === "25") return 500;
  if (c2 === "28") return 403;
  if (["2D", "38", "39", "3B", "40"].includes(c2)) return 500;
  if (code === "53400") return 500;
  if (c2 === "53") return 503;
  if (["54", "55", "57", "58", "F0", "HV"].includes(c2)) return 500;
  if (code === "P0001") return 400;
  if (c2 === "P0") return 500;
  if (c2 === "XX") return 500;
  if (code === "42883" || code === "42P01") return 404;
  if (code === "42P17") return 500;
  if (code === "42501") return authed ? 403 : 401;
  return 400;
}

/** apply_synced_shot(jsonb) contract (20260906000000_apply_synced_shot_replay_after_lock.sql). */
const APPLY_STATUSES = new Set([
  "accepted",
  "auth.required",
  "access.permit_not_found",
  "access.permit_not_reserved",
  "access.permit_expired",
  "access.paywall_required",
  "shot.session_not_found",
  "shot.id_conflict",
]);
/** reserve_analysis_permit(text).result contract (20260902150000_free_rating_identity_ledger.sql). */
const RESERVE_STATUSES = new Set(["accepted", "auth.required", "access.paywall_required"]);

// ──────────────────────────────── outcomes ───────────────────────────────────

interface Outcome {
  kind: "ok" | "error" | "connection_lost";
  rows?: number;
  result?: unknown;
  sqlstate?: string;
  status?: number;
  message?: string;
}

interface Snapshot {
  counts: Record<string, { a: number; b: number; t: number }>;
  digests: Record<string, { a: string | null; b: string | null }>;
  auth: { users: number; identities: number };
}

interface ResultRow {
  i: number;
  seed: number;
  replay: string;
  lane: number;
  actor: string;
  family: string;
  target: string;
  mustReject: boolean;
  mustAccept: boolean;
  note: string;
  payload: { sha256: string; bytes: number; preview: string };
  outcome: Outcome;
  delta: Record<string, { a: number; b: number; t: number }>;
  otherTouched: string[];
  stored?: unknown;
  verdict: "HELD" | "BROKEN";
  reasons: string[];
  ms: number;
}

const USER_TABLES = CLIENT_TABLES.filter(
  (t) => !["profiles", "free_rating_ledger", "webhook_events"].includes(t),
);

function snapshotSql(): string {
  const parts: string[] = [];
  for (const t of USER_TABLES) {
    parts.push(
      `'${t}', jsonb_build_object('a', (select count(*) from public.${t} where user_id = $1::uuid), 'b', (select count(*) from public.${t} where user_id = $2::uuid), 't', (select count(*) from public.${t}))`,
    );
  }
  parts.push(
    `'profiles', jsonb_build_object('a', (select count(*) from public.profiles where id = $1::uuid), 'b', (select count(*) from public.profiles where id = $2::uuid), 't', (select count(*) from public.profiles))`,
  );
  parts.push(
    `'free_rating_ledger', jsonb_build_object('a', 0, 'b', 0, 't', (select count(*) from public.free_rating_ledger))`,
  );
  parts.push(
    `'webhook_events', jsonb_build_object('a', 0, 'b', 0, 't', (select count(*) from public.webhook_events))`,
  );
  const digests: string[] = [];
  for (const t of USER_TABLES) {
    digests.push(
      `'${t}', jsonb_build_object('a', (select md5(string_agg(x::text, '|' order by x::text)) from public.${t} x where user_id = $1::uuid), 'b', (select md5(string_agg(x::text, '|' order by x::text)) from public.${t} x where user_id = $2::uuid))`,
    );
  }
  digests.push(
    `'profiles', jsonb_build_object('a', (select md5(x::text) from public.profiles x where id = $1::uuid), 'b', (select md5(x::text) from public.profiles x where id = $2::uuid))`,
  );
  const ledgerOf = (p: string) =>
    `(select md5(string_agg(x::text, '|' order by x::text)) from public.free_rating_ledger x where x.identity_hash in (select public.free_rating_identity_hash(i.provider, i.provider_id) from auth.identities i where i.user_id = ${p}::uuid))`;
  digests.push(
    `'free_rating_ledger', jsonb_build_object('a', ${ledgerOf("$1")}, 'b', ${ledgerOf("$2")})`,
  );
  return `select jsonb_build_object('counts', jsonb_build_object(${parts.join(", ")}), 'digests', jsonb_build_object(${digests.join(", ")}), 'auth', jsonb_build_object('users', (select count(*) from auth.users), 'identities', (select count(*) from auth.identities))) as s`;
}
const SNAPSHOT_SQL = snapshotSql();

async function snapshot(r: Reserved, a: string, b: string): Promise<Snapshot> {
  const rows = await r.unsafe(SNAPSHOT_SQL, [a, b]);
  return rows[0].s as Snapshot;
}

function diffCounts(
  before: Snapshot,
  after: Snapshot,
): Record<string, { a: number; b: number; t: number }> {
  const out: Record<string, { a: number; b: number; t: number }> = {};
  for (const [t, c] of Object.entries(after.counts)) {
    const p = before.counts[t];
    const d = { a: c.a - p.a, b: c.b - p.b, t: c.t - p.t };
    if (d.a !== 0 || d.b !== 0 || d.t !== 0) out[t] = d;
  }
  if (after.auth.users !== before.auth.users || after.auth.identities !== before.auth.identities) {
    out["auth"] = {
      a: 0,
      b: 0,
      t: after.auth.users - before.auth.users + after.auth.identities - before.auth.identities,
    };
  }
  return out;
}

function touched(before: Snapshot, after: Snapshot, who: "a" | "b"): string[] {
  const out: string[] = [];
  for (const [t, d] of Object.entries(after.digests)) {
    if (d[who] !== before.digests[t][who]) out.push(t);
  }
  return out;
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function preview(text: string): string {
  const s = text.length > 200 ? text.slice(0, 200) + `…(+${text.length - 200})` : text;
  return JSON.stringify(s).slice(1, -1);
}

function errOutcome(e: unknown, authed: boolean): Outcome {
  const err = e as { code?: string; message?: string; name?: string };
  const code = typeof err.code === "string" ? err.code : "";
  if (
    code === "CONNECTION_CLOSED" ||
    code === "CONNECTION_ENDED" ||
    code === "CONNECTION_DESTROYED" ||
    code === "CONNECT_TIMEOUT"
  ) {
    return {
      kind: "connection_lost",
      sqlstate: code,
      message: String(err.message ?? err).slice(0, 300),
    };
  }
  if (/^[0-9A-Z]{5}$/.test(code)) {
    return {
      kind: "error",
      sqlstate: code,
      status: pgrstStatus(code, authed),
      message: String(err.message ?? "").slice(0, 300),
    };
  }
  // postgres.js parameter/format errors surface before the server sees them
  return {
    kind: "error",
    sqlstate: `client:${code || err.name || "unknown"}`,
    status: 400,
    message: String(err.message ?? err).slice(0, 300),
  };
}

// ───────────────────────────── statement builders ────────────────────────────

function qident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** JSON text for a PostgREST-shaped row, honouring the __rawToken__ marker. */
function rowJson(row: Record<string, unknown>): { json: string; cols: string[] } {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "__rawToken__" || k === "__rawCol__") continue;
    clean[k] = v;
  }
  let json = JSON.stringify(clean);
  if (typeof row.__rawCol__ === "string" && typeof row.__rawToken__ === "string") {
    json = json.replace(`"__RAW_${row.__rawCol__}__"`, row.__rawToken__);
  }
  return { json, cols: Object.keys(clean) };
}

async function execOp(r: Reserved, c: Case, authed: boolean): Promise<Outcome> {
  const op = c.op;
  switch (op.kind) {
    case "rpc_apply": {
      const rows = await r.unsafe("select public.apply_synced_shot($1::text::jsonb) as r", [
        op.jsonText,
      ]);
      return { kind: "ok", rows: rows.length, result: rows[0]?.r };
    }
    case "rpc_reserve": {
      const rows = await r.unsafe("select * from public.reserve_analysis_permit($1::text)", [
        op.key,
      ]);
      return { kind: "ok", rows: rows.length, result: rows[0] };
    }
    case "rpc_reserve_pair": {
      const first = await r.unsafe("select * from public.reserve_analysis_permit($1::text)", [
        op.keys[0],
      ]);
      const second = await r.unsafe("select * from public.reserve_analysis_permit($1::text)", [
        op.keys[1],
      ]);
      return {
        kind: "ok",
        rows: first.length + second.length,
        result: { first: first[0], second: second[0] },
      };
    }
    case "rpc_call": {
      const rows = await r.unsafe(`select * from public.${qident(op.fn)}(${op.argSql})`, op.params);
      return { kind: "ok", rows: rows.length, result: rows.slice(0, 3) };
    }
    case "insert": {
      const { json, cols } = rowJson(op.row);
      const t = `public.${qident(op.table)}`;
      if (cols.length === 0) {
        const rows = await r.unsafe(`insert into ${t} default values returning 1 as one`);
        return { kind: "ok", rows: rows.length };
      }
      const list = cols.map(qident).join(", ");
      // $1::text::json — with a bare ::json the driver would JSON-encode the
      // string a second time and populate_record would see a scalar
      const rows = await r.unsafe(
        `insert into ${t} (${list}) select ${list} from json_populate_record(null::${t}, $1::text::json) returning 1 as one`,
        [json],
      );
      return { kind: "ok", rows: rows.length };
    }
    case "update": {
      const { json, cols } = rowJson(op.set);
      const t = `public.${qident(op.table)}`;
      const sets = cols.map((col) => `${qident(col)} = r.${qident(col)}`).join(", ");
      const rows = await r.unsafe(
        `update ${t} as x set ${sets} from json_populate_record(null::${t}, $1::text::json) r where x.${qident(op.whereCol)} = $2::${op.whereCast} returning 1 as one`,
        [json, op.whereParam],
      );
      return { kind: "ok", rows: rows.length };
    }
    case "delete": {
      const rows = await r.unsafe(
        `delete from public.${qident(op.table)} where ${qident(op.whereCol)} = $1::${op.whereCast} returning 1 as one`,
        [op.whereParam],
      );
      return { kind: "ok", rows: rows.length };
    }
    case "select": {
      const rows = await r.unsafe(
        `select * from public.${qident(op.table)} where ${qident(op.whereCol)} = $1::${op.whereCast}`,
        [op.whereParam],
      );
      return { kind: "ok", rows: rows.length };
    }
  }
  void authed;
}

async function setActor(r: Reserved, actor: string, fx: Fixture): Promise<void> {
  // PostgREST's own preamble: role, then the per-request claims (the shim's
  // auth.uid() reads request.jwt.claim.sub; request.jwt.claims mirrors the
  // hosted GUC for anything that reads the full JSON).
  if (actor === "anon") {
    await r.unsafe("set local role anon");
    await r.unsafe("set local request.jwt.claim.sub = ''");
    await r.unsafe(`set local request.jwt.claims = '{"role":"anon"}'`);
    return;
  }
  await r.unsafe("set local role authenticated");
  if (actor === "nullsub") {
    await r.unsafe("set local request.jwt.claim.sub = ''");
    await r.unsafe(`set local request.jwt.claims = '{"role":"authenticated"}'`);
    return;
  }
  if (actor === "badsub") {
    await r.unsafe(`set local request.jwt.claim.sub = '../../etc/passwd'`);
    await r.unsafe(
      `set local request.jwt.claims = '{"role":"authenticated","sub":"../../etc/passwd"}'`,
    );
    return;
  }
  const uid = actor === "bob" ? fx.bob.id : fx.alice.id;
  await r.unsafe(`set local request.jwt.claim.sub = '${uid}'`);
  await r.unsafe(`set local request.jwt.claims = '{"role":"authenticated","sub":"${uid}"}'`);
}

// ─────────────────────────────────── verdict ─────────────────────────────────

function payloadText(c: Case): string {
  const op = c.op;
  switch (op.kind) {
    case "rpc_apply":
      return op.jsonText;
    case "rpc_reserve":
      return op.key === null ? "NULL" : op.key;
    case "rpc_reserve_pair":
      return JSON.stringify(op.keys);
    case "rpc_call":
      return `${op.fn}(${op.argSql}) ${JSON.stringify(op.params)}`;
    case "insert":
      return rowJson(op.row).json;
    case "update":
      return `${rowJson(op.set).json} where ${op.whereCol} = ${op.whereParam}`;
    case "delete":
    case "select":
      return `where ${op.whereCol} = ${op.whereParam}`;
  }
}

function judge(
  c: Case,
  out: Outcome,
  delta: Record<string, { a: number; b: number; t: number }>,
  otherTouched: string[],
  stored: unknown,
): { verdict: "HELD" | "BROKEN"; reasons: string[] } {
  const reasons: string[] = [];
  const authed = c.actor === "alice" || c.actor === "bob";
  const mine: "a" | "b" | null = c.actor === "alice" ? "a" : c.actor === "bob" ? "b" : null;
  const anyDelta = Object.keys(delta).length > 0;

  if (out.kind === "connection_lost") reasons.push("connection lost during statement");
  if (out.kind === "error" && (out.status ?? 0) >= 500) {
    reasons.push(`5xx-class SQLSTATE ${out.sqlstate} (PostgREST ${out.status}) — ${out.message}`);
  }
  if (out.kind === "error" && out.sqlstate === "57014")
    reasons.push("statement_timeout (8s hosted default) — payload is a DoS vector");
  if (otherTouched.length > 0)
    reasons.push(`OTHER user's rows changed in ${otherTouched.join(",")}`);
  if (delta.auth) reasons.push("auth schema rows changed");
  if (mine) {
    const otherKey = mine === "a" ? "b" : "a";
    for (const [t, d] of Object.entries(delta)) {
      if (t !== "auth" && d[otherKey] !== 0)
        reasons.push(`${t}: ${d[otherKey]} row(s) attributed to the OTHER user`);
      if (
        t !== "auth" &&
        d.t !== d.a + d.b &&
        t !== "free_rating_ledger" &&
        t !== "webhook_events"
      ) {
        reasons.push(`${t}: ${d.t - d.a - d.b} row(s) owned by neither fixture user`);
      }
    }
  } else {
    if (anyDelta) reasons.push(`${c.actor} wrote rows: ${JSON.stringify(delta)}`);
    if (
      out.kind === "ok" &&
      (out.rows ?? 0) > 0 &&
      c.op.kind !== "rpc_apply" &&
      c.op.kind !== "rpc_reserve"
    ) {
      // anon: no table grant and no function EXECUTE besides the pure
      // player_rank_tier(numeric). null/malformed sub: authenticated role, so
      // granted functions run — but under a null uid they must return no
      // fixture data.
      const pure = c.op.kind === "rpc_call" && c.op.fn === "player_rank_tier";
      const leaked =
        JSON.stringify(out.result ?? "").includes(ALICE) ||
        JSON.stringify(out.result ?? "").includes(BOB);
      if (c.actor === "anon" && !pure)
        reasons.push(`anon received ${out.rows} row(s) / a result from ${c.target}`);
      if (c.actor !== "anon" && (c.op.kind !== "rpc_call" || leaked))
        reasons.push(
          `${c.actor} received ${out.rows} row(s) from ${c.target}${leaked ? " naming a fixture user" : ""}`,
        );
    }
    if (out.kind === "ok" && c.op.kind === "rpc_apply" && out.result !== "auth.required")
      reasons.push(
        `${c.actor} apply_synced_shot returned ${JSON.stringify(out.result)} (expected auth.required)`,
      );
    if (
      out.kind === "ok" &&
      c.op.kind === "rpc_reserve" &&
      String((out.result as Record<string, unknown> | undefined)?.result) !== "auth.required"
    ) {
      reasons.push(`${c.actor} reserve_analysis_permit returned ${JSON.stringify(out.result)}`);
    }
  }

  if (out.kind === "ok") {
    if (c.op.kind === "rpc_apply") {
      const status = String(out.result ?? "");
      const typed = APPLY_STATUSES.has(status) || /^shot\.write_failed:[0-9A-Z]{5}$/.test(status);
      if (!typed)
        reasons.push(
          `apply_synced_shot returned an out-of-contract status ${JSON.stringify(status)}`,
        );
      if (status.includes(c.canary)) reasons.push("RPC status echoes payload text");
      if (c.mustReject && status === "accepted") reasons.push("must-reject payload was ACCEPTED");
      if (c.mustReject && anyDelta)
        reasons.push(`must-reject payload wrote ${JSON.stringify(delta)}`);
      if (c.mustAccept && status !== "accepted")
        reasons.push(`valid control payload refused: ${status}`);
      if (!c.mustReject && status === "accepted" && !anyDelta)
        reasons.push("accepted but nothing written");
      if (status !== "accepted" && anyDelta)
        reasons.push(`status ${status} but rows written ${JSON.stringify(delta)}`);
    } else if (c.op.kind === "rpc_reserve" || c.op.kind === "rpc_reserve_pair") {
      const results =
        c.op.kind === "rpc_reserve"
          ? [out.result]
          : Object.values(out.result as Record<string, unknown>);
      for (const res of results) {
        const rec = (res ?? {}) as Record<string, unknown>;
        const status = String(rec.result ?? "");
        if (!RESERVE_STATUSES.has(status))
          reasons.push(`reserve_analysis_permit returned out-of-contract ${JSON.stringify(res)}`);
        if (c.mustReject && status === "accepted") reasons.push("must-reject key was ACCEPTED");
        if (c.mustAccept && status !== "accepted" && status !== "access.paywall_required")
          reasons.push(`valid reserve refused: ${status}`);
      }
      if (c.mustReject && anyDelta) reasons.push(`must-reject key wrote ${JSON.stringify(delta)}`);
    } else if (c.op.kind === "insert") {
      if (c.mustReject && (out.rows ?? 0) > 0)
        reasons.push(`must-reject row INSERTED into ${c.op.table}`);
      if (c.mustAccept && (out.rows ?? 0) === 0) reasons.push("valid control row not inserted");
    } else if (c.op.kind === "update" || c.op.kind === "delete") {
      if (c.mustReject && (out.rows ?? 0) > 0)
        reasons.push(`must-reject ${c.op.kind} touched ${out.rows} row(s)`);
    } else if (c.op.kind === "select") {
      if (c.mustReject && (out.rows ?? 0) > 0)
        reasons.push(`hostile select returned ${out.rows} row(s)`);
    } else if (c.op.kind === "rpc_call" && !authed) {
      // handled above (any rows for anon/nullsub/badsub is a leak) except player_rank_tier
    }
  } else if (out.kind === "error") {
    if (c.mustAccept) reasons.push(`valid control refused with ${out.sqlstate}: ${out.message}`);
    if (anyDelta) reasons.push(`error ${out.sqlstate} but rows written ${JSON.stringify(delta)}`);
    if (
      out.message &&
      out.message.includes(c.canary) &&
      (c.op.kind === "rpc_apply" || c.op.kind === "rpc_reserve")
    ) {
      // PostgREST relays the message to the client; RPC errors must not echo payloads
      reasons.push("RPC error message echoes payload text");
    }
  }
  if (stored && typeof stored === "object" && "mismatch" in (stored as Record<string, unknown>)) {
    reasons.push(
      `stored row differs from payload: ${JSON.stringify((stored as Record<string, unknown>).mismatch)}`,
    );
  }
  return { verdict: reasons.length === 0 ? "HELD" : "BROKEN", reasons };
}

/** For an accepted apply: what actually landed, compared with the payload. */
async function inspectApply(r: Reserved, c: Case, out: Outcome): Promise<unknown> {
  if (c.op.kind !== "rpc_apply" || out.kind !== "ok" || out.result !== "accepted") return undefined;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(c.op.jsonText) as Record<string, unknown>;
  } catch {
    return { mismatch: "accepted but the payload is not JSON on the client side" };
  }
  const id = typeof doc.id === "string" ? doc.id : null;
  if (!id) return { mismatch: "accepted without an id" };
  let rows: Record<string, unknown>[];
  try {
    rows = await r.unsafe(
      `select s.user_id, s.shot_type, s.result_kind, s.overall_score::text as overall_score, s.analysis_confidence::text as analysis_confidence, s.captured_at::text as captured_at, s.session_id, s.app_version,
              (select count(*) from public.shot_phases p where p.shot_id = s.id) as phases,
              (select count(*) from public.shot_checkpoints k where k.shot_id = s.id) as checkpoints,
              (select ap.status from public.analysis_permits ap where ap.id::text = $2::text) as permit_status
         from public.shots s where s.id = $1::uuid`,
      [id, typeof doc.analysisPermitId === "string" ? doc.analysisPermitId : ""],
    );
  } catch (e) {
    return { mismatch: `accepted with an id that is not a uuid: ${(e as Error).message}` };
  }
  if (rows.length === 0) return { mismatch: "accepted but no shots row" };
  const row = rows[0];
  const expectedUser = c.actor === "bob" ? BOB : ALICE;
  const mismatch: string[] = [];
  if (row.user_id !== expectedUser) mismatch.push(`user_id=${row.user_id}`);
  if (typeof doc.shotType === "string" && row.shot_type !== doc.shotType)
    mismatch.push(`shot_type stored ${JSON.stringify(row.shot_type)}`);
  if (typeof doc.resultKind === "string" && row.result_kind !== doc.resultKind)
    mismatch.push(`result_kind stored ${row.result_kind}`);
  const expectPermit = doc.resultKind === "scored" ? "finalized" : "released";
  if (row.permit_status !== expectPermit)
    mismatch.push(`permit_status=${row.permit_status} (expected ${expectPermit})`);
  const phases = Array.isArray(doc.phases) ? doc.phases.length : 0;
  if (Number(row.phases) !== phases) mismatch.push(`phases stored ${row.phases} of ${phases}`);
  const summary = { ...row, phases: Number(row.phases), checkpoints: Number(row.checkpoints) };
  return mismatch.length > 0 ? { ...summary, mismatch } : summary;
}

// ─────────────────────────────── fixture setup ───────────────────────────────

async function setupFixture(sql: Sql): Promise<Fixture> {
  const mk = async (id: string, sub: string, premium: boolean): Promise<UserFixture> => {
    await sql.unsafe(
      `delete from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', $1::text)`,
      [sub],
    );
    await sql.unsafe(`delete from auth.users where id = $1::uuid`, [id]);
    await sql.unsafe(
      `insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values ($1::uuid, $2::text, '{"provider":"google","providers":["google"]}', '{"full_name":"Stress Fixture"}')`,
      [id, `${sub}@stress.invalid`],
    );
    await sql.unsafe(
      `insert into auth.identities (provider_id, user_id, identity_data, provider) values ($1::text, $2::uuid, jsonb_build_object('sub', $1::text, 'email', $3::text), 'google')`,
      [sub, id, `${sub}@stress.invalid`],
    );
    if (premium) {
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, product_key) values ($1::uuid, true, 'pickle_sensei_pro_lifetime') on conflict (user_id) do update set premium = true`,
        [id],
      );
    }
    const [session] = await sql.unsafe(
      `insert into public.sessions (id, user_id, kind, started_at) values (gen_random_uuid(), $1::uuid, 'practice', '2026-05-01T09:00:00Z') returning id`,
      [id],
    );
    // one committed scored shot per user (owner write, no JWT sub → gate bypass; ledger trigger counts it)
    await sql.unsafe(
      `insert into public.analysis_permits (user_id, idempotency_key, status, outcome) values ($1::uuid, 'fixture-0', 'finalized', 'scored')`,
      [id],
    );
    const [shot] = await sql.unsafe(
      `insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
       values (gen_random_uuid(), $1::uuid, $2::uuid, 'dink', 'side', '2026-05-01T09:05:00Z', 0, 300, 900, 7.25, 0.9, 'scored', '1.0.0', 'b', 'p', 'pd', 's', 'ph', 'sc', 'c') returning id`,
      [id, session.id],
    );
    // a LIVE reserved permit the hostile payloads try to consume
    const [permit] = await sql.unsafe(
      `insert into public.analysis_permits (user_id, idempotency_key, status) values ($1::uuid, 'fixture-live', 'reserved') returning id`,
      [id],
    );
    return { id, sessionId: session.id, permitId: permit.id, shotId: shot.id, premium };
  };
  const alice = await mk(ALICE, "google-sub-alice-stress", false);
  const bob = await mk(BOB, "google-sub-bob-stress", true);
  return { alice, bob };
}

// ───────────────────────────── generated stream (mode A) ─────────────────────

async function runCase(
  r: Reserved,
  c: Case,
  fx: Fixture,
  base: Snapshot,
  lane: number,
): Promise<ResultRow> {
  const authed = c.actor === "alice" || c.actor === "bob";
  const text = payloadText(c);
  const digest = await sha256(text);
  const t0 = performance.now();
  let out: Outcome;
  let after: Snapshot | null = null;
  let stored: unknown;
  try {
    await r.unsafe("begin");
    // hosted default for the authenticated role; a payload that trips it is a 500
    await r.unsafe("set local statement_timeout = '8s'");
    await setActor(r, c.actor, fx);
    await r.unsafe("savepoint sp");
    try {
      out = await execOp(r, c, authed);
    } catch (e) {
      out = errOutcome(e, authed);
      if (out.kind === "error") await r.unsafe("rollback to savepoint sp");
    }
    if (out.kind !== "connection_lost") {
      await r.unsafe("reset role");
      after = await snapshot(r, fx.alice.id, fx.bob.id);
      stored = await inspectApply(r, c, out);
    }
  } catch (e) {
    out = errOutcome(e, authed);
    if (out.kind !== "connection_lost")
      out = { kind: "connection_lost", sqlstate: out.sqlstate, message: `harness: ${out.message}` };
  } finally {
    try {
      await r.unsafe("rollback");
    } catch {
      // connection gone; the caller re-reserves
    }
  }
  const ms = Math.round(performance.now() - t0);
  const delta = after ? diffCounts(base, after) : {};
  const otherKey: "a" | "b" | null = c.actor === "alice" ? "b" : c.actor === "bob" ? "a" : null;
  const otherTouched = after
    ? otherKey
      ? touched(base, after, otherKey)
      : [...touched(base, after, "a"), ...touched(base, after, "b")]
    : [];
  const { verdict, reasons } = judge(c, out, delta, otherTouched, stored);
  if (ms > 2000) reasons.push(`slow: ${ms}ms`);
  return {
    i: c.index,
    seed: c.seed,
    replay: `STRESS_SEED=${SEED} STRESS_REPLAY=${c.index}`,
    lane,
    actor: c.actor,
    family: c.family,
    target: c.target,
    mustReject: c.mustReject,
    mustAccept: c.mustAccept,
    note: c.note,
    payload: {
      sha256: digest,
      bytes: new TextEncoder().encode(text).length,
      preview: preview(text),
    },
    outcome:
      out.kind === "ok"
        ? {
            ...out,
            result:
              out.result === undefined
                ? undefined
                : JSON.parse(
                    JSON.stringify(out.result, (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
                  ),
          }
        : out,
    delta,
    otherTouched,
    stored,
    verdict: ms > 2000 ? "BROKEN" : verdict,
    reasons,
    ms,
  };
}

async function streamCampaign(sql: Sql, fx: Fixture, indexes: number[]): Promise<ResultRow[]> {
  const r0 = await sql.reserve();
  const base = await snapshot(r0, fx.alice.id, fx.bob.id);
  r0.release();
  const results: ResultRow[] = [];
  let cursor = 0;
  const lanes = Math.min(LANES, indexes.length);
  await Promise.all(
    Array.from({ length: lanes }, async (_, lane) => {
      let r = await sql.reserve();
      while (cursor < indexes.length) {
        const idx = indexes[cursor++];
        const c = buildCase(idx, SEED, fx);
        const row = await runCase(r, c, fx, base, lane);
        results.push(row);
        if (row.outcome.kind === "connection_lost") {
          try {
            r.release();
          } catch {
            // already gone
          }
          r = await sql.reserve();
        }
        if (results.length % 250 === 0) console.error(`  … ${results.length}/${indexes.length}`);
      }
      r.release();
    }),
  );
  results.sort((x, y) => x.i - y.i);
  return results;
}

// ───────────────────────── committed concurrency rounds (mode B) ─────────────

interface RoundStep {
  round: number;
  isolation: string;
  lane: number;
  user: "u1" | "u2";
  step: number;
  kind: string;
  seed: number;
  note: string;
  outcome: Outcome;
  retries: number;
  verdict: "HELD" | "BROKEN";
  reasons: string[];
  ms: number;
}

interface RoundReport {
  round: number;
  isolation: string;
  users: { u1: string; u2: string };
  steps: RoundStep[];
  invariants: Array<{ name: string; held: boolean; detail: unknown }>;
}

class Barrier {
  private waiting: Array<() => void> = [];
  constructor(private readonly n: number) {}
  arrive(): Promise<void> {
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      if (this.waiting.length === this.n) {
        const all = this.waiting;
        this.waiting = [];
        for (const w of all) w();
      }
    });
  }
}

async function withTx<T>(
  r: Reserved,
  isolation: string,
  uid: string,
  body: () => Promise<T>,
): Promise<{ value: T | Outcome; retries: number }> {
  let retries = 0;
  for (;;) {
    await r.unsafe(`begin isolation level ${isolation}`);
    try {
      await r.unsafe("set local statement_timeout = '8s'");
      await r.unsafe("set local role authenticated");
      await r.unsafe(`set local request.jwt.claim.sub = '${uid}'`);
      await r.unsafe(`set local request.jwt.claims = '{"role":"authenticated","sub":"${uid}"}'`);
      const value = await body();
      await r.unsafe("commit");
      return { value, retries };
    } catch (e) {
      try {
        await r.unsafe("rollback");
      } catch {
        // connection gone
      }
      const out = errOutcome(e, true);
      if (out.sqlstate === "40001" && retries < 5) {
        retries++;
        await new Promise((res) => setTimeout(res, 5 + Math.random() * 20));
        continue;
      }
      return { value: out, retries };
    }
  }
}

async function concurrencyRound(sql: Sql, round: number): Promise<RoundReport> {
  const isolation = round % 2 === 0 ? "read committed" : "serializable";
  const prng = new Prng(caseSeed(SEED, 1_000_000 + round));
  const lanesPerUser = Math.max(1, Math.floor(LANES / 2));
  const laneCount = lanesPerUser * 2;
  const mkUser = async (tag: string): Promise<UserFixture> => {
    const id = prng.uuid();
    const sub = `google-sub-round${round}-${tag}-${SEED}`;
    await sql.unsafe(
      `delete from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', $1::text)`,
      [sub],
    );
    await sql.unsafe(
      `insert into auth.users (id, email, raw_app_meta_data) values ($1::uuid, $2::text, '{"provider":"google","providers":["google"]}')`,
      [id, `${sub}@stress.invalid`],
    );
    await sql.unsafe(
      `insert into auth.identities (provider_id, user_id, identity_data, provider) values ($1::text, $2::uuid, jsonb_build_object('sub', $1::text), 'google')`,
      [sub, id],
    );
    const [session] = await sql.unsafe(
      `insert into public.sessions (id, user_id, kind, started_at) values (gen_random_uuid(), $1::uuid, 'practice', '2026-05-02T09:00:00Z') returning id`,
      [id],
    );
    const [permit] = await sql.unsafe(
      `insert into public.analysis_permits (user_id, idempotency_key, status) values ($1::uuid, 'round-live', 'reserved') returning id`,
      [id],
    );
    const [shot] = await sql.unsafe(
      `insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
       values (gen_random_uuid(), $1::uuid, $2::uuid, 'lowconf-fixture', 'side', '2026-05-02T09:05:00Z', 0, 300, 900, null, 0.2, 'low_confidence', '1.0.0', 'b', 'p', 'pd', 's', 'ph', 'sc', 'c') returning id`,
      [id, session.id],
    );
    return { id, sessionId: session.id, permitId: permit.id, shotId: shot.id, premium: false };
  };
  const u1 = await mkUser("u1");
  const u2 = await mkUser("u2");
  const hostileShots: Array<{ id: string; user: string }> = [];
  const acceptedScored: Record<"u1" | "u2", Set<string>> = { u1: new Set(), u2: new Set() };
  const sharedShot: Record<"u1" | "u2", string> = {
    u1: JSON.stringify({
      ...validShot(prng, u1, "shared-u1"),
      id: prng.uuid(),
      analysisPermitId: u1.permitId,
      shotType: "shared-race",
    }),
    u2: JSON.stringify({
      ...validShot(prng, u2, "shared-u2"),
      id: prng.uuid(),
      analysisPermitId: u2.permitId,
      shotType: "shared-race",
    }),
  };
  const barrier = new Barrier(laneCount);
  const steps: RoundStep[] = [];

  await Promise.all(
    Array.from({ length: laneCount }, async (_, lane) => {
      const userKey: "u1" | "u2" = lane < lanesPerUser ? "u1" : "u2";
      const me = userKey === "u1" ? u1 : u2;
      const other = userKey === "u1" ? u2 : u1;
      const laneRng = new Prng(caseSeed(SEED, 2_000_000 + round * 100 + lane));
      const r = await sql.reserve();
      const record = (
        step: number,
        kind: string,
        seed: number,
        note: string,
        res: { value: unknown; retries: number },
        reasons: string[],
        t0: number,
      ) => {
        const out: Outcome =
          res.value &&
          typeof res.value === "object" &&
          "kind" in (res.value as Record<string, unknown>) &&
          ["ok", "error", "connection_lost"].includes(String((res.value as Outcome).kind))
            ? (res.value as Outcome)
            : { kind: "ok", result: res.value };
        if (out.kind === "error" && (out.status ?? 0) >= 500)
          reasons.push(`5xx-class SQLSTATE ${out.sqlstate}: ${out.message}`);
        if (out.kind === "connection_lost") reasons.push("connection lost");
        steps.push({
          round,
          isolation,
          lane,
          user: userKey,
          step,
          kind,
          seed,
          note,
          outcome: out,
          retries: res.retries,
          verdict: reasons.length ? "BROKEN" : "HELD",
          reasons,
          ms: Math.round(performance.now() - t0),
        });
      };
      for (let step = 0; step < ROUND_STEPS; step++) {
        const seed = caseSeed(SEED, 3_000_000 + round * 10_000 + lane * 100 + step);
        const rng = new Prng(seed);
        const t0 = performance.now();
        const roll = step === Math.floor(ROUND_STEPS / 2) ? 4 : rng.int(4);
        if (roll === 0) {
          // reserve → apply a scored shot (the edge's real flow), 2 committed txs
          const key = `rk-${seed.toString(16)}`;
          const reserved = await withTx(
            r,
            isolation,
            me.id,
            async () =>
              (await r.unsafe("select * from public.reserve_analysis_permit($1::text)", [key]))[0],
          );
          const reasons: string[] = [];
          const rec = reserved.value as Record<string, unknown>;
          const status = String(rec?.result ?? "");
          if (!RESERVE_STATUSES.has(status) && !("kind" in (rec ?? {})))
            reasons.push(`reserve out-of-contract ${JSON.stringify(rec)}`);
          record(step, "reserve", seed, `key ${key} → ${status}`, reserved, reasons, t0);
          if (status === "accepted" && typeof rec.permit_id === "string") {
            const shot = {
              ...validShot(rng, me, `lane${lane}`),
              analysisPermitId: rec.permit_id,
              resultKind: "scored",
              overallScore: 6.5,
              confidence: 0.8,
              shotType: `lane-${userKey}`,
            };
            const t1 = performance.now();
            const applied = await withTx(
              r,
              isolation,
              me.id,
              async () =>
                (
                  await r.unsafe("select public.apply_synced_shot($1::text::jsonb) as r", [
                    JSON.stringify(shot),
                  ])
                )[0].r,
            );
            const reasons2: string[] = [];
            const st = String(applied.value ?? "");
            if (st === "accepted") acceptedScored[userKey].add(shot.id);
            else if (
              st !== "access.paywall_required" &&
              !(isolation === "serializable" && st === "shot.write_failed:40001")
            )
              reasons2.push(`apply with a fresh permit returned ${JSON.stringify(applied.value)}`);
            record(
              step,
              "apply",
              seed,
              `shot ${shot.id} permit ${rec.permit_id} → ${st}`,
              applied,
              reasons2,
              t1,
            );
          }
        } else if (roll === 1) {
          // hostile apply, committed: a must-reject payload must leave no row.
          // The case is generated relative to THIS lane's user (actor ⇒ me).
          const probeActor = buildCase(700_000 + (seed % 100_000), SEED, {
            alice: u1,
            bob: u2,
          }).actor;
          const fx: Fixture =
            probeActor === "bob" ? { alice: other, bob: me } : { alice: me, bob: other };
          const c = buildCase(700_000 + (seed % 100_000), SEED, fx);
          const fam = c.family;
          let jsonText: string;
          let mustReject: boolean;
          let note: string;
          if (c.op.kind === "rpc_apply" && c.family !== "grant_sweep") {
            jsonText = c.op.jsonText;
            mustReject = c.mustReject;
            note = `${fam}: ${c.note}`;
          } else {
            const base = validShot(rng, me, `h${seed.toString(16)}`);
            base.id = laneRng.uuid();
            base.analysisPermitId = other.permitId; // cross-user permit
            jsonText = JSON.stringify(base);
            mustReject = true;
            note = "cross_user: other user's live permit";
          }
          let doc: Record<string, unknown> | null = null;
          try {
            doc = JSON.parse(jsonText) as Record<string, unknown>;
          } catch {
            // malformed on purpose
          }
          const hostileId =
            doc && typeof doc.id === "string" && /^[0-9a-f-]{36}$/.test(doc.id) ? doc.id : null;
          if (mustReject && hostileId) hostileShots.push({ id: hostileId, user: me.id });
          const res = await withTx(
            r,
            isolation,
            me.id,
            async () =>
              (
                await r.unsafe("select public.apply_synced_shot($1::text::jsonb) as r", [jsonText])
              )[0].r,
          );
          const reasons: string[] = [];
          const st = String(res.value ?? "");
          if (mustReject && st === "accepted")
            reasons.push("must-reject payload ACCEPTED (committed)");
          // a replay of the (low_confidence) fixture shot is 'accepted' idempotently without a write
          if (
            !mustReject &&
            st === "accepted" &&
            hostileId &&
            hostileId !== me.shotId &&
            doc?.resultKind === "scored"
          )
            acceptedScored[userKey].add(hostileId);
          record(step, "hostile_apply", seed, note, res, reasons, t0);
        } else if (roll === 2) {
          // hostile PostgREST-shaped insert, committed
          const table = rng.pick([...INSERTABLE]);
          const fams = [
            "long_strings",
            "null_bytes",
            "path_traversal",
            "wrong_type",
            "proto_pollution",
            "numeric_edge",
            "future_schema",
            "empty_containers",
            "unicode_norm",
            "timestamp_edge",
            "cross_user",
          ] as const;
          const family = rng.pick(fams);
          const m = mutateRow(
            rng,
            family,
            table,
            validRow(rng, table, me, `r${seed.toString(16)}`),
            other,
            `r${seed.toString(16)}`,
          );
          const c: Case = {
            index: -1,
            seed,
            actor: userKey === "u1" ? "alice" : "bob",
            family,
            target: `table.${table}.insert`,
            mustReject: m.mustReject,
            mustAccept: false,
            note: m.note,
            op: { kind: "insert", table, row: m.row },
            canary: `r${seed.toString(16)}`,
          };
          const res = await withTx(r, isolation, me.id, () => execOp(r, c, true));
          const reasons: string[] = [];
          const out = res.value as Outcome;
          if (m.mustReject && out.kind === "ok" && (out.rows ?? 0) > 0)
            reasons.push(`must-reject row INSERTED into ${table} (committed)`);
          record(step, "hostile_insert", seed, `${family} ${table}: ${m.note}`, res, reasons, t0);
        } else if (roll === 3) {
          // cross-user probes, committed
          const probe = rng.int(3);
          let res: { value: unknown; retries: number };
          const reasons: string[] = [];
          let note: string;
          if (probe === 0) {
            note = "finalize OTHER user's live permit";
            res = await withTx(
              r,
              isolation,
              me.id,
              async () =>
                (
                  await r.unsafe(
                    "update public.analysis_permits set status = 'finalized' where id = $1::uuid returning 1 as one",
                    [other.permitId],
                  )
                ).length,
            );
            if (res.value !== 0 && typeof res.value === "number")
              reasons.push(`updated ${res.value} of the other user's permits`);
          } else if (probe === 1) {
            note = "select OTHER user's shots";
            res = await withTx(
              r,
              isolation,
              me.id,
              async () =>
                (await r.unsafe("select id from public.shots where user_id = $1::uuid", [other.id]))
                  .length,
            );
            if (res.value !== 0 && typeof res.value === "number")
              reasons.push(`read ${res.value} of the other user's shots`);
          } else {
            note = "insert a session owned by the OTHER user";
            res = await withTx(
              r,
              isolation,
              me.id,
              async () =>
                (
                  await r.unsafe(
                    "insert into public.sessions (id, user_id, kind, started_at, notes) values (gen_random_uuid(), $1::uuid, 'practice', now(), 'XPROBE-foreign-session') returning 1 as one",
                    [other.id],
                  )
                ).length,
            );
            if (typeof res.value === "number")
              reasons.push(`inserted ${res.value} session(s) for the other user`);
          }
          record(step, "cross_user_probe", seed, note, res, reasons, t0);
        } else {
          // duplicate-apply race: every lane of this user replays the SAME shot at the barrier
          await barrier.arrive();
          const res = await withTx(
            r,
            isolation,
            me.id,
            async () =>
              (
                await r.unsafe("select public.apply_synced_shot($1::text::jsonb) as r", [
                  sharedShot[userKey],
                ])
              )[0].r,
          );
          const reasons: string[] = [];
          const st = String(res.value ?? "");
          // every replica must settle typed: accepted (one write + replays),
          // paywall (allowance gone), or — SERIALIZABLE only — a retryable 40001
          // the RPC's write block surfaces as shot.write_failed:40001
          if (
            st !== "accepted" &&
            st !== "access.paywall_required" &&
            st !== "access.permit_not_reserved" &&
            !(isolation === "serializable" && st === "shot.write_failed:40001")
          )
            reasons.push(`duplicate race returned ${JSON.stringify(res.value)}`);
          const shared = JSON.parse(sharedShot[userKey]) as { id: string; resultKind: string };
          if (st === "accepted" && shared.resultKind === "scored")
            acceptedScored[userKey].add(shared.id);
          record(
            step,
            "duplicate_apply_race",
            seed,
            `shared ${userKey} ${shared.resultKind} shot ${shared.id}`,
            res,
            reasons,
            t0,
          );
        }
      }
      r.release();
    }),
  );

  // post-round invariants (owner view)
  const invariants: RoundReport["invariants"] = [];
  for (const [key, u] of [
    ["u1", u1],
    ["u2", u2],
  ] as const) {
    const [state] = await sql.unsafe(
      `select (select count(*) from public.shots where user_id = $1::uuid and result_kind = 'scored') as scored,
              (select count(*) from public.shots where user_id = $1::uuid and shot_type = 'shared-race') as shared_rows,
              (select count(*) from public.analysis_permits where user_id = $1::uuid and status = 'finalized') as finalized,
              (select count(*) from public.analysis_permits where user_id = $1::uuid and status = 'reserved') as reserved,
              (select coalesce(max(scored_count), 0) from public.free_rating_ledger where identity_hash in (select public.free_rating_identity_hash(i.provider, i.provider_id) from auth.identities i where i.user_id = $1::uuid)) as ledger,
              (select count(*) from public.shots where user_id = $1::uuid and shot_type like 'lane-%' and shot_type <> $2::text) as foreign_lane_rows,
              (select count(*) from public.sessions where user_id = $1::uuid and notes = 'XPROBE-foreign-session') as sessions,
              (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', result_kind, 'type', shot_type) order by created_at), '[]') from public.shots where user_id = $1::uuid) as shots,
              (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'status', status, 'outcome', outcome, 'key', idempotency_key) order by created_at), '[]') from public.analysis_permits where user_id = $1::uuid) as permits`,
      [u.id, `lane-${key}`],
    );
    const scored = Number(state.scored);
    invariants.push({
      name: `${key}: free lifetime cap (scored ≤ 2)`,
      held: scored <= 2,
      detail: { scored },
    });
    invariants.push({
      name: `${key}: shared shot replayed by ${lanesPerUser} lanes stored once`,
      held: Number(state.shared_rows) <= 1,
      detail: { shared_rows: Number(state.shared_rows) },
    });
    invariants.push({
      name: `${key}: ledger == scored shots`,
      held: Number(state.ledger) === scored,
      detail: { ledger: Number(state.ledger), scored },
    });
    const acceptedIds = [...acceptedScored[key]].sort();
    invariants.push({
      name: `${key}: finalized permits == distinct accepted scored shots`,
      held: Number(state.finalized) === acceptedIds.length && scored === acceptedIds.length,
      detail: {
        finalized: Number(state.finalized),
        acceptedScored: acceptedIds,
        shots: state.shots,
        permits: state.permits,
      },
    });
    invariants.push({
      name: `${key}: no rows tagged by the other user's lanes`,
      held: Number(state.foreign_lane_rows) === 0,
      detail: { foreign_lane_rows: Number(state.foreign_lane_rows) },
    });
    invariants.push({
      name: `${key}: no session inserted by the other user`,
      held: Number(state.sessions) === 0,
      detail: { foreign_probe_sessions: Number(state.sessions) },
    });
  }
  if (hostileShots.length > 0) {
    const rows = await sql.unsafe(
      `select s.id from public.shots s join jsonb_to_recordset($1::text::jsonb) as h(id uuid, "user" uuid) on h.id = s.id and h."user" = s.user_id`,
      [JSON.stringify(hostileShots)],
    );
    invariants.push({
      name: "no must-reject shot id present for its sender",
      held: rows.length === 0,
      detail: { hostile: hostileShots.length, present: rows.length },
    });
  }
  const [orphans] = await sql.unsafe(
    `select (select count(*) from public.shot_phases p join public.shots s on s.id = p.shot_id where p.user_id <> s.user_id) as phases,
            (select count(*) from public.shot_checkpoints k join public.shots s on s.id = k.shot_id where k.user_id <> s.user_id) as checkpoints,
            (select count(*) from public.shots s join public.sessions x on x.id = s.session_id where s.user_id <> x.user_id) as shots_in_foreign_sessions`,
  );
  invariants.push({
    name: "no detail rows owned by a different user than their shot",
    held: Number(orphans.phases) === 0 && Number(orphans.checkpoints) === 0,
    detail: { phases: Number(orphans.phases), checkpoints: Number(orphans.checkpoints) },
  });
  invariants.push({
    name: "no shot attached to another user's session",
    held: Number(orphans.shots_in_foreign_sessions) === 0,
    detail: { shots_in_foreign_sessions: Number(orphans.shots_in_foreign_sessions) },
  });

  // cleanup (ledger rows have no FK on purpose)
  for (const u of [u1, u2]) {
    await sql.unsafe(
      `delete from public.free_rating_ledger where identity_hash in (select public.free_rating_identity_hash(i.provider, i.provider_id) from auth.identities i where i.user_id = $1::uuid)`,
      [u.id],
    );
    await sql.unsafe(`delete from auth.users where id = $1::uuid`, [u.id]);
  }
  return { round, isolation, users: { u1: u1.id, u2: u2.id }, steps, invariants };
}

// ──────────────────────────────────── main ───────────────────────────────────

async function main(): Promise<number> {
  const sql = postgres(PG_URL, {
    max: LANES + 4,
    prepare: false,
    connect_timeout: 15,
    idle_timeout: 0,
    onnotice: () => {},
  });
  await Deno.mkdir(OUT, { recursive: true });
  const startedAt = new Date().toISOString();
  const [ver] = await sql.unsafe("select version() as v");
  console.error(`postgres: ${ver.v}`);
  console.error(
    `seed=${SEED} iter=${ITER} lanes=${LANES} rounds=${ROUNDS} steps=${ROUND_STEPS} out=${OUT}`,
  );

  const fx = await setupFixture(sql);
  const indexes: number[] = [];
  if (REPLAY.length > 0) {
    for (const i of REPLAY) for (let k = 0; k < REPEAT; k++) indexes.push(i);
  } else {
    for (let i = 0; i < ITER; i++) indexes.push(i);
  }

  const t0 = performance.now();
  const results = await streamCampaign(sql, fx, indexes);
  const streamMs = Math.round(performance.now() - t0);

  const rounds: RoundReport[] = [];
  if (!SKIP_ROUNDS && REPLAY.length === 0) {
    for (let round = 0; round < ROUNDS; round++) {
      console.error(`  round ${round} (${round % 2 === 0 ? "read committed" : "serializable"})…`);
      rounds.push(await concurrencyRound(sql, round));
    }
  }

  // fixture cleanup
  for (const u of [fx.alice, fx.bob]) {
    await sql.unsafe(
      `delete from public.free_rating_ledger where identity_hash in (select public.free_rating_identity_hash(i.provider, i.provider_id) from auth.identities i where i.user_id = $1::uuid)`,
      [u.id],
    );
    await sql.unsafe(`delete from auth.users where id = $1::uuid`, [u.id]);
  }
  await sql.end();

  const broken = results.filter((r) => r.verdict === "BROKEN");
  const byFamily: Record<
    string,
    {
      executed: number;
      held: number;
      broken: number;
      mustReject: number;
      rejected: number;
      accepted: number;
    }
  > = {};
  const byTarget: Record<string, { executed: number; broken: number }> = {};
  const byActor: Record<string, { executed: number; broken: number }> = {};
  const sqlstates: Record<string, number> = {};
  const rpcStatuses: Record<string, number> = {};
  for (const r of results) {
    const f = (byFamily[r.family] ??= {
      executed: 0,
      held: 0,
      broken: 0,
      mustReject: 0,
      rejected: 0,
      accepted: 0,
    });
    f.executed++;
    if (r.verdict === "HELD") f.held++;
    else f.broken++;
    if (r.mustReject) f.mustReject++;
    const rejected =
      r.outcome.kind === "error" ||
      (r.outcome.kind === "ok" &&
        r.target.startsWith("rpc.apply") &&
        r.outcome.result !== "accepted") ||
      (r.outcome.kind === "ok" && (r.outcome.rows ?? 0) === 0 && !r.target.startsWith("rpc."));
    if (rejected) f.rejected++;
    else f.accepted++;
    (byTarget[r.target] ??= { executed: 0, broken: 0 }).executed++;
    if (r.verdict === "BROKEN") byTarget[r.target].broken++;
    (byActor[r.actor] ??= { executed: 0, broken: 0 }).executed++;
    if (r.verdict === "BROKEN") byActor[r.actor].broken++;
    if (r.outcome.kind === "error" && r.outcome.sqlstate)
      sqlstates[r.outcome.sqlstate] = (sqlstates[r.outcome.sqlstate] ?? 0) + 1;
    if (r.outcome.kind === "ok" && r.target === "rpc.apply_synced_shot") {
      const s = String(r.outcome.result);
      rpcStatuses[s] = (rpcStatuses[s] ?? 0) + 1;
    }
  }
  const roundSteps = rounds.flatMap((r) => r.steps);
  const roundBroken = roundSteps.filter((s) => s.verdict === "BROKEN");
  const invariantsFailed = rounds.flatMap((r) =>
    r.invariants
      .filter((i) => !i.held)
      .map((i) => ({ round: r.round, isolation: r.isolation, ...i })),
  );
  const executed = results.length + roundSteps.length;

  const summary = {
    harness: "supabase/tests/stress/boundary_malformed.ts",
    startedAt,
    finishedAt: new Date().toISOString(),
    postgres: ver.v,
    seed: SEED,
    iter: ITER,
    lanes: LANES,
    replay: REPLAY,
    repeat: REPEAT,
    streamMs,
    scenariosExecuted: executed,
    stream: {
      executed: results.length,
      held: results.length - broken.length,
      broken: broken.length,
    },
    rounds: rounds.map((r) => ({
      round: r.round,
      isolation: r.isolation,
      steps: r.steps.length,
      broken: r.steps.filter((s) => s.verdict === "BROKEN").length,
      retries40001: r.steps.reduce((a, s) => a + s.retries, 0),
      invariants: r.invariants.length,
      invariantsFailed: r.invariants.filter((i) => !i.held).length,
    })),
    byFamily,
    byTarget,
    byActor,
    sqlstates,
    applyStatuses: rpcStatuses,
    brokenIndexes: broken.map((r) => r.i),
    brokenSummary: broken.map((r) => ({
      i: r.i,
      seed: r.seed,
      actor: r.actor,
      family: r.family,
      target: r.target,
      note: r.note,
      reasons: r.reasons,
      replay: r.replay,
    })),
    roundBroken: roundBroken.map((s) => ({
      round: s.round,
      isolation: s.isolation,
      lane: s.lane,
      user: s.user,
      step: s.step,
      kind: s.kind,
      seed: s.seed,
      note: s.note,
      reasons: s.reasons,
    })),
    invariantsFailed,
  };
  await Deno.writeTextFile(`${OUT}/results.json`, JSON.stringify(results, null, 0));
  await Deno.writeTextFile(`${OUT}/rounds.json`, JSON.stringify(rounds, null, 0));
  await Deno.writeTextFile(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
  console.error(
    JSON.stringify({ ...summary, brokenSummary: undefined, roundBroken: undefined }, null, 2),
  );
  for (const b of summary.brokenSummary)
    console.error(
      `BROKEN #${b.i} seed=${b.seed} ${b.actor} ${b.family} ${b.target} :: ${b.note} :: ${b.reasons.join(" | ")}`,
    );
  for (const b of summary.roundBroken)
    console.error(
      `ROUND BROKEN r${b.round} ${b.isolation} lane${b.lane} ${b.user} step${b.step} ${b.kind} :: ${b.note} :: ${b.reasons.join(" | ")}`,
    );
  for (const inv of invariantsFailed)
    console.error(
      `INVARIANT FAILED r${inv.round} ${inv.isolation}: ${inv.name} ${JSON.stringify(inv.detail)}`,
    );
  const ok = broken.length === 0 && roundBroken.length === 0 && invariantsFailed.length === 0;
  console.error(
    `${ok ? "HELD" : "BROKEN"}: ${executed} iterations (${results.length} generated + ${roundSteps.length} committed round steps); reports in ${OUT}`,
  );
  void HERE;
  return ok ? 0 : 1;
}

try {
  Deno.exit(await main());
} catch (e) {
  console.error("harness error:", e);
  Deno.exit(2);
}
