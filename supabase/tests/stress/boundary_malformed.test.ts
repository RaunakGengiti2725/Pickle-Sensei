/**
 * db-sessions-captures — BOUNDARY / MALFORMED INPUT stress harness.
 *
 * Drives public.sessions, public.captures, public.evaluation_trials and
 * public.analysis_feedback (plus the sessionId path of apply_synced_shot)
 * on a disposable postgres:16 with shim_auth.sql + every migration applied
 * (./pg_up.sh), from N INDEPENDENT connections as role `authenticated` with a
 * real JWT sub (two users), under READ COMMITTED and SERIALIZABLE, with
 * seeded malformed/boundary inputs: truncated JSON, wrong types, prototype-
 * pollution keys, numeric overflow / NaN / Infinity / -0, NUL bytes and
 * invalid UTF-8, 64 KiB+ strings against codepoint caps, path traversal in
 * ids, future schema versions, empty arrays/objects, unicode normalization
 * pairs, calendar-impossible timestamps.
 *
 * Contract asserted per iteration (the lens):
 *   - a malformed value is REJECTED with a typed SQLSTATE (class 22/23,
 *     42501, 54xxx; 40001 only under SERIALIZABLE) — never an untyped/internal
 *     error, never a client-library throw, never a connection loss;
 *   - a rejected statement leaves NO row behind;
 *   - a value inside the documented contract is accepted and round-trips;
 *   - RLS: nothing owned by the other user is visible or writable.
 * Values the schema accepts but a stricter upstream contract forbids are
 * recorded as POLICY GAPS (reported, not asserted).
 *
 *   ./pg_up.sh                                # prints STRESS_PG_URL
 *   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres \
 *     STRESS_ITER=3000 STRESS_SEED=20260904 STRESS_LANES=8 \
 *     STRESS_OUT_DIR=/tmp/pickle-stress deno test -A --config deno.json boundary_malformed.test.ts
 *
 * Replay ONE iteration from its printed seed:
 *   STRESS_PG_URL=... STRESS_REPLAY=<iteration seed> deno test -A --config deno.json boundary_malformed.test.ts
 *
 * Without STRESS_PG_URL every test is `ignore`d — an ignored run is NOT a
 * pass. Defaults are small (STRESS_ITER=300) so the file can live in the
 * suite; the campaign scale is opt-in through the env.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  type Candidate,
  codepoints,
  describe,
  type Expect,
  graphemes,
  int4For,
  invalidUtf8Hex,
  iterSeed,
  jsonFor,
  numericFor,
  Prng,
  textFor,
  timestampFor,
  utf8Bytes,
  uuidFor,
  enumFor,
} from "./gen.ts";

const PG_URL = Deno.env.get("STRESS_PG_URL") ?? "";
const ignore = PG_URL === "";
const envInt = (k: string, d: number) => {
  const v = Number(Deno.env.get(k) ?? "");
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : d;
};
const ITER = envInt("STRESS_ITER", 300);
const SEED = envInt("STRESS_SEED", 20260904);
const LANES = envInt("STRESS_LANES", 8);
const OUT_DIR = Deno.env.get("STRESS_OUT_DIR") ?? "/tmp/pickle-stress";
const REPLAY = Deno.env.get("STRESS_REPLAY");
const FLAKY_RERUNS = 10;

type Sql = ReturnType<typeof postgres>;

// Two fixed users (replays must hit the same ids).
const USER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const USER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const SESSION_A = "aaaaaaaa-5e55-4000-8000-00000000000a";
const SESSION_B = "bbbbbbbb-5e55-4000-8000-00000000000b";
// per-user sessions that own-row UPDATEs are allowed to move (never probed as "other")
const SESSION_A_END = "aaaaaaaa-e0d0-4000-8000-00000000000a";
const SESSION_B_END = "bbbbbbbb-e0d0-4000-8000-00000000000b";
const TRIAL_B = "bbbbbbbb-7217-4000-8000-00000000000b";
const ANALYSIS_A = "aaaaaaaa-a7a1-4000-8000-00000000000a"; // A already rated it
const ANALYSIS_B = "bbbbbbbb-a7a1-4000-8000-00000000000b"; // B already rated it

const GRACEFUL_ALWAYS = new Set([
  "42501",
  "54001",
  "54000",
  "54023",
  "22P02",
  "22P05",
  "22021",
  "22007",
  "22008",
  "22009",
  "22003",
  "23514",
  "23502",
  "23505",
  "23503",
  "22001",
  "22P03",
  "22023",
]);
function isGraceful(sqlstate: string, isolation: string): boolean {
  if (GRACEFUL_ALWAYS.has(sqlstate)) return true;
  if (sqlstate.startsWith("22") || sqlstate.startsWith("23")) return true;
  if (sqlstate === "40001" || sqlstate === "40P01") return isolation === "serializable";
  return false;
}

type Isolation = "read committed" | "serializable";
type Actor = "A" | "B" | "owner";

interface FieldReport {
  expect: Expect;
  tags: string[];
  note: string;
  gap?: string;
}

interface Plan {
  surface: string;
  op: string;
  actor: Actor;
  isolation: Isolation;
  expect: Expect;
  fields: Record<string, FieldReport>;
  gaps: string[];
  /** SQL with $n placeholders + params, executed inside the actor's tx. */
  statement: string;
  params: (string | null)[];
  /** Owner-side probe: does the row the statement targeted exist? null when
   * the statement could not have produced a row (e.g. malformed pk). */
  probe: null | { sql: string; params: (string | null)[] };
  /** What an accepted statement must have produced (rows affected). */
  acceptRows?: number;
  /** RPC surfaces: the text code returned. */
  rpcKnownCodes?: Set<string>;
}

type Verdict = "HELD" | "BROKEN" | "GAP";
interface IterationRow {
  i: number;
  seed: number;
  surface: string;
  op: string;
  actor: Actor;
  isolation: Isolation;
  expect: Expect;
  fields: Record<string, FieldReport>;
  outcome: "accepted" | "rejected" | "client_throw";
  sqlstate: string | null;
  message: string | null;
  rows: number | null;
  rpcResult: string | null;
  writeObserved: boolean | null;
  verdict: Verdict;
  reason: string;
  gaps: string[];
  ms: number;
  replay: string;
}

const users: Record<Actor, string | null> = { A: USER_A, B: USER_B, owner: null };
const other = (a: Actor): string => (a === "A" ? USER_B : USER_A);
const ownSession = (a: Actor): string => (a === "A" ? SESSION_A : SESSION_B);
const ownEndableSession = (a: Actor): string => (a === "A" ? SESSION_A_END : SESSION_B_END);
const otherSession = (a: Actor): string => (a === "A" ? SESSION_B : SESSION_A);
const ownRatedAnalysis = (a: Actor): string => (a === "A" ? ANALYSIS_A : ANALYSIS_B);

function combine(fields: Record<string, Candidate<string | null> | Candidate<string>>): {
  expect: Expect;
  report: Record<string, FieldReport>;
  gaps: string[];
} {
  let expect: Expect = "accept";
  const report: Record<string, FieldReport> = {};
  const gaps: string[] = [];
  for (const [k, c] of Object.entries(fields)) {
    report[k] = { expect: c.expect, tags: c.tags, note: c.note, gap: c.policyGap };
    if (c.expect === "reject") expect = "reject";
    else if (c.expect === "either" && expect !== "reject") expect = "either";
    if (c.policyGap) gaps.push(`${k}:${c.policyGap}`);
  }
  return { expect, report, gaps };
}

// ------------------------------------------------------------------ surfaces

/** nil/max uuids are shared across iterations and users: a second insert
 * legitimately collides, so the oracle is "either" for them. */
const isSharedId = (c: Candidate): boolean =>
  c.tags.includes("uuid-nil") || c.tags.includes("uuid-max");

type SurfaceBuilder = (rng: Prng, actor: Actor, iso: Isolation) => Plan;

const sessionsInsert: SurfaceBuilder = (rng, actor, isolation): Plan => {
  const attack = rng.int(1, 2); // how many fields carry a non-plain candidate
  const fresh = rng.uuid();
  const plain = {
    id: { value: fresh, expect: "accept", tags: ["uuid-valid"], note: "fresh v4" } as Candidate,
    user_id: {
      value: users[actor],
      expect: "accept",
      tags: ["own-uid"],
      note: "own uid",
    } as Candidate,
    kind: {
      value: rng.pick(["practice", "game"]),
      expect: "accept",
      tags: ["enum-valid"],
      note: "valid kind",
    } as Candidate,
    started_at: {
      value: "2026-09-01T10:00:00.000Z",
      expect: "accept",
      tags: ["iso-valid"],
      note: "iso",
    } as Candidate,
    ended_at: { value: null, expect: "accept", tags: ["null"], note: "NULL" } as Candidate,
    event_count: { value: "0", expect: "accept", tags: ["int-plain"], note: "0" } as Candidate,
    notes: { value: null, expect: "accept", tags: ["null"], note: "NULL" } as Candidate,
  };
  const keys = Object.keys(plain) as (keyof typeof plain)[];
  const chosen = new Set<string>();
  while (chosen.size < attack) chosen.add(rng.pick(keys));
  const f = { ...plain };
  for (const k of chosen) {
    switch (k) {
      case "id":
        f.id = rng.bool(0.15)
          ? {
              value: otherSession(actor),
              expect: "reject",
              tags: ["pk-collision", "other-user-id"],
              note: "other user's session id (PK)",
            }
          : uuidFor(rng, false);
        break;
      case "user_id": {
        const r = rng.next();
        if (r < 0.35) {
          f.user_id = {
            value: other(actor),
            expect: "reject",
            tags: ["rls", "spoof-uid"],
            note: "OTHER user's uid",
          };
        } else if (r < 0.5) {
          f.user_id = {
            value: rng.uuid(),
            expect: "reject",
            tags: ["rls", "unknown-uid"],
            note: "unknown uid (RLS before FK)",
          };
        } else {
          // any syntactically valid uid that is not the caller's must be refused by RLS
          const c = uuidFor(rng, false);
          f.user_id =
            c.expect === "accept"
              ? { ...c, expect: "reject", tags: [...c.tags, "rls", "foreign-uid"] }
              : c;
        }
        break;
      }
      case "kind":
        f.kind = enumFor(rng, ["practice", "game"], false);
        break;
      case "started_at":
        f.started_at = timestampFor(rng, false, false);
        break;
      case "ended_at":
        f.ended_at = timestampFor(rng, false, true);
        break;
      case "event_count":
        f.event_count = int4For(rng, 0, false);
        break;
      case "notes":
        f.notes = textFor(rng, 4000, true);
        break;
    }
  }
  if (isSharedId(f.id)) f.id = { ...f.id, expect: "either" }; // nil/max may already exist
  const { expect, report, gaps } = combine(f);
  const idValid = f.id.expect === "accept" && f.id.tags[0] !== "pk-collision";
  return {
    surface: "sessions.insert",
    op: `insert sessions attacking [${[...chosen].join(",")}]`,
    actor,
    isolation,
    expect,
    fields: report,
    gaps,
    statement: `insert into public.sessions (id, user_id, kind, started_at, ended_at, event_count, notes)
       values ($1::text::uuid, $2::text::uuid, $3, $4::text::timestamptz, $5::text::timestamptz, $6::text::int, $7)`,
    params: [
      f.id.value,
      f.user_id.value,
      f.kind.value,
      f.started_at.value,
      f.ended_at.value,
      f.event_count.value,
      f.notes.value,
    ],
    probe: idValid
      ? {
          sql: `select count(*)::int as n from public.sessions where id = $1::text::uuid`,
          params: [f.id.value],
        }
      : null,
    acceptRows: 1,
  };
};

const sessionsUpdate: SurfaceBuilder = (rng, actor, isolation): Plan => {
  const r = rng.next();
  if (r < 0.45) {
    // allowed column, own row
    const ts = timestampFor(rng, false, true);
    const { expect, report, gaps } = combine({ ended_at: ts });
    return {
      surface: "sessions.update",
      op: "update own ended_at",
      actor,
      isolation,
      expect,
      fields: report,
      gaps,
      statement: `update public.sessions set ended_at = $1::text::timestamptz where id = $2::text::uuid`,
      params: [ts.value, ownEndableSession(actor)],
      probe: null,
      acceptRows: 1,
    };
  }
  if (r < 0.75) {
    // forbidden column (no column grant) — must be 42501 whatever the value
    const col = rng.pick([
      "notes",
      "kind",
      "started_at",
      "event_count",
      "user_id",
      "id",
      "created_at",
      "updated_at",
    ]);
    const val: Candidate =
      col === "notes"
        ? textFor(rng, 4000, true)
        : col === "kind"
          ? enumFor(rng, ["practice", "game"], false)
          : col === "event_count"
            ? int4For(rng, 0, false)
            : col === "user_id" || col === "id"
              ? uuidFor(rng, false)
              : timestampFor(rng, false, false);
    const cast =
      col === "notes" || col === "kind"
        ? ""
        : col === "event_count"
          ? "::text::int"
          : col === "user_id" || col === "id"
            ? "::text::uuid"
            : "::text::timestamptz";
    return {
      surface: "sessions.update",
      op: `update forbidden column ${col}`,
      actor,
      isolation,
      expect: "reject",
      fields: {
        [col]: {
          expect: "reject",
          tags: ["column-grant", ...val.tags],
          note: `no UPDATE grant on ${col}: ${val.note}`,
        },
      },
      gaps: [],
      statement: `update public.sessions set ${col} = $1${cast} where id = $2::text::uuid`,
      params: [val.value, ownSession(actor)],
      probe: null,
    };
  }
  // other user's row — RLS must hide it (0 rows, no error, no change). A
  // malformed SET value may be rejected at plan time or never evaluated
  // (no matching row): both are graceful.
  const ts = timestampFor(rng, false, false);
  return {
    surface: "sessions.update",
    op: "update OTHER user's ended_at (RLS filter)",
    actor,
    isolation,
    expect: ts.expect === "reject" ? "either" : "accept",
    fields: {
      ended_at: { expect: ts.expect, tags: ["rls", ...ts.tags], note: ts.note },
      target: { expect: "accept", tags: ["other-user-row"], note: "other user's session" },
    },
    gaps: [],
    statement: `update public.sessions set ended_at = $1::text::timestamptz where id = $2::text::uuid`,
    params: [ts.value, otherSession(actor)],
    probe: {
      sql: `select (ended_at is not null)::int as n from public.sessions where id = $1::text::uuid`,
      params: [otherSession(actor)],
    },
    acceptRows: 0,
  };
};

const sessionsDelete: SurfaceBuilder = (rng, actor, isolation): Plan => {
  const r = rng.next();
  if (r < 0.5) {
    return {
      surface: "sessions.delete",
      op: "delete OTHER user's session (RLS filter)",
      actor,
      isolation,
      expect: "accept",
      fields: {
        target: { expect: "accept", tags: ["rls", "other-user-row"], note: "other user's session" },
      },
      gaps: [],
      statement: `delete from public.sessions where id = $1::text::uuid`,
      params: [otherSession(actor)],
      probe: {
        sql: `select (count(*) = 0)::int as n from public.sessions where id = $1::text::uuid`,
        params: [otherSession(actor)],
      },
      acceptRows: 0,
    };
  }
  // `where id = NULL` is a legitimate 0-row statement; nil/max may exist and be
  // the caller's own row ("either").
  const id = lookupId(uuidFor(rng, true));
  return {
    surface: "sessions.delete",
    op: "delete by fuzzed id",
    actor,
    isolation,
    expect: id.expect,
    fields: { id: { expect: id.expect, tags: id.tags, note: id.note } },
    gaps: [],
    statement: `delete from public.sessions where id = $1::text::uuid`,
    params: [id.value],
    probe: null,
    acceptRows: 0,
  };
};

/** Oracle for a fuzzed id used only in a WHERE clause: malformed -> reject,
 * NULL -> 0 rows (accept), shared nil/max -> either, otherwise 0 rows. */
function lookupId(c: Candidate): Candidate {
  if (c.value === null) return { ...c, expect: "accept", note: "NULL in WHERE (0 rows)" };
  if (isSharedId(c)) return { ...c, expect: "either" };
  return c;
}

const capturesClientWrite: SurfaceBuilder = (rng, actor, isolation): Plan => {
  const id = rng.uuid();
  const r = rng.next();
  const ts = timestampFor(rng, true, false);
  const mode = enumFor(rng, ["automatic_pose_trigger", "imported_video"], false);
  const fps = numericFor(rng, false, false);
  if (r < 0.6) {
    return {
      surface: "captures.client_write",
      op: "insert captures as authenticated (no INSERT grant)",
      actor,
      isolation,
      expect: "reject",
      fields: {
        captured_at: { expect: "reject", tags: ["grant", ...ts.tags], note: ts.note },
        capture_mode: { expect: "reject", tags: ["grant", ...mode.tags], note: mode.note },
        fps: { expect: "reject", tags: ["grant", ...fps.tags], note: fps.note },
      },
      gaps: [],
      statement: `insert into public.captures (id, user_id, captured_at, duration_ms, fps, capture_mode, evidence_status, status)
         values ($1::text::uuid, $2::text::uuid, $3::text::timestamptz, 1000, $4::text::numeric, $5, 'valid', 'analyzed')`,
      params: [id, users[actor], ts.value, fps.value, mode.value],
      probe: {
        sql: `select count(*)::int as n from public.captures where id = $1::text::uuid`,
        params: [id],
      },
    };
  }
  if (r < 0.8) {
    const col = rng.pick(["status", "fps", "declared_stroke", "user_id"]);
    return {
      surface: "captures.client_write",
      op: `update captures.${col} as authenticated (no UPDATE grant)`,
      actor,
      isolation,
      expect: "reject",
      fields: {
        [col]: { expect: "reject", tags: ["grant"], note: "no client UPDATE on captures" },
      },
      gaps: [],
      statement:
        col === "user_id"
          ? `update public.captures set user_id = $1::text::uuid where user_id = $1::text::uuid`
          : col === "fps"
            ? `update public.captures set fps = $1::text::numeric where user_id = $2::text::uuid`
            : `update public.captures set ${col} = $1 where user_id = $2::text::uuid`,
      params:
        col === "user_id"
          ? [users[actor]]
          : [col === "fps" ? (fps.value ?? "1") : "analyzed", users[actor]],
      probe: null,
    };
  }
  return {
    surface: "captures.client_write",
    op: "delete captures as authenticated (no DELETE grant)",
    actor,
    isolation,
    expect: "reject",
    fields: { target: { expect: "reject", tags: ["grant"], note: "no client DELETE on captures" } },
    gaps: [],
    statement: `delete from public.captures where user_id = $1::text::uuid`,
    params: [users[actor]],
    probe: null,
  };
};

/** Service/owner plane: the one writer captures has. Exercises the CHECKs. */
const capturesOwnerInsert: SurfaceBuilder = (rng, actor, isolation): Plan => {
  const fresh = rng.uuid();
  const f = {
    id: { value: fresh, expect: "accept", tags: ["uuid-valid"], note: "fresh v4" } as Candidate,
    user_id: {
      value: users[actor],
      expect: "accept",
      tags: ["uid"],
      note: "owner-plane row for user",
    } as Candidate,
    session_id: { value: null, expect: "accept", tags: ["null"], note: "NULL" } as Candidate,
    captured_at: {
      value: "2026-09-01T10:00:00.000Z",
      expect: "accept",
      tags: ["iso-valid"],
      note: "iso",
    } as Candidate,
    duration_ms: {
      value: "1000",
      expect: "accept",
      tags: ["int-plain"],
      note: "1000",
    } as Candidate,
    fps: { value: "29.97", expect: "accept", tags: ["numeric-plain"], note: "29.97" } as Candidate,
    capture_mode: {
      value: "automatic_pose_trigger",
      expect: "accept",
      tags: ["enum-valid"],
      note: "valid",
    } as Candidate,
    declared_stroke: { value: null, expect: "accept", tags: ["null"], note: "NULL" } as Candidate,
    evidence_status: {
      value: "valid",
      expect: "accept",
      tags: ["enum-valid"],
      note: "valid",
    } as Candidate,
    status: {
      value: "analyzed",
      expect: "accept",
      tags: ["enum-valid"],
      note: "valid",
    } as Candidate,
    joint_coverage: { value: null, expect: "accept", tags: ["null"], note: "NULL" } as Candidate,
    pose_tracked_ms: { value: null, expect: "accept", tags: ["null"], note: "NULL" } as Candidate,
  };
  const keys = Object.keys(f) as (keyof typeof f)[];
  const attack = rng.int(1, 2);
  const chosen = new Set<string>();
  while (chosen.size < attack) chosen.add(rng.pick(keys.filter((k) => k !== "user_id")));
  for (const k of chosen) {
    switch (k) {
      case "id":
        f.id = uuidFor(rng, false);
        break;
      case "session_id":
        f.session_id = rng.bool(0.3)
          ? {
              value: otherSession(actor),
              expect: "accept",
              tags: ["fk", "other-user-session"],
              note: "OTHER user's session (FK exists; owner plane, RLS bypassed)",
              policyGap: "captures_session_fk_not_owner_scoped",
            }
          : rng.bool(0.3)
            ? {
                value: rng.uuid(),
                expect: "reject",
                tags: ["fk", "missing"],
                note: "session id that does not exist (FK)",
              }
            : uuidFor(rng, true);
        if (isSharedId(f.session_id)) {
          f.session_id = {
            ...f.session_id,
            expect: "either",
            tags: [...f.session_id.tags, "fk"],
            note: `${f.session_id.note} (may exist as a session)`,
          };
        } else if (
          f.session_id.tags[0]?.startsWith("uuid-") &&
          f.session_id.expect === "accept" &&
          f.session_id.value !== null
        ) {
          f.session_id = {
            ...f.session_id,
            expect: "reject",
            tags: [...f.session_id.tags, "fk", "missing"],
          };
        }
        break;
      case "captured_at":
        f.captured_at = timestampFor(rng, true, false);
        break;
      case "duration_ms":
        f.duration_ms = int4For(rng, 0, false);
        break;
      case "fps":
        f.fps = numericFor(rng, false, false);
        break;
      case "capture_mode":
        f.capture_mode = enumFor(rng, ["automatic_pose_trigger", "imported_video"], false);
        break;
      case "declared_stroke":
        f.declared_stroke = textFor(rng, 64, true);
        break;
      case "evidence_status":
        f.evidence_status = enumFor(
          rng,
          ["valid", "legacy", "corrupt", "metadata_mismatch"],
          false,
        );
        break;
      case "status":
        f.status = enumFor(rng, ["awaiting_model", "analyzed"], false);
        break;
      case "joint_coverage":
        f.joint_coverage = numericFor(rng, true, true, { precision: 5, scale: 4 });
        break;
      case "pose_tracked_ms":
        f.pose_tracked_ms = int4For(rng, 0, true);
        break;
    }
  }
  if (isSharedId(f.id)) f.id = { ...f.id, expect: "either" };
  const { expect, report, gaps } = combine(f);
  const idValid = f.id.expect === "accept";
  return {
    surface: "captures.owner_insert",
    op: `owner-plane insert captures attacking [${[...chosen].join(",")}]`,
    actor: "owner",
    isolation,
    expect,
    fields: report,
    gaps,
    statement: `insert into public.captures (id, user_id, session_id, captured_at, duration_ms, fps, capture_mode, declared_stroke, evidence_status, status, joint_coverage, pose_tracked_ms)
       values ($1::text::uuid, $2::text::uuid, $3::text::uuid, $4::text::timestamptz, $5::text::int, $6::text::numeric, $7, $8, $9, $10, $11::text::numeric, $12::text::int)`,
    params: [
      f.id.value,
      f.user_id.value,
      f.session_id.value,
      f.captured_at.value,
      f.duration_ms.value,
      f.fps.value,
      f.capture_mode.value,
      f.declared_stroke.value,
      f.evidence_status.value,
      f.status.value,
      f.joint_coverage.value,
      f.pose_tracked_ms.value,
    ],
    probe: idValid
      ? {
          sql: `select count(*)::int as n from public.captures where id = $1::text::uuid`,
          params: [f.id.value],
        }
      : null,
    acceptRows: 1,
  };
};

const trialsInsert: SurfaceBuilder = (rng, actor, isolation): Plan => {
  const fresh = rng.uuid();
  const r = rng.next();
  if (r < 0.1) {
    // update / delete on the append-only ledger — 42501 no matter what
    const del = rng.bool();
    return {
      surface: "evaluation_trials.mutate",
      op: del ? "delete own trials (append-only)" : "update own trial payload (append-only)",
      actor,
      isolation,
      expect: "reject",
      fields: {
        ledger: {
          expect: "reject",
          tags: ["append-only", "grant"],
          note: del ? "DELETE" : "UPDATE",
        },
      },
      gaps: [],
      statement: del
        ? `delete from public.evaluation_trials where user_id = $1::text::uuid`
        : `update public.evaluation_trials set payload = '{}'::jsonb where user_id = $1::text::uuid`,
      params: [users[actor]],
      probe: null,
    };
  }
  let id: Candidate =
    r < 0.2
      ? {
          value: TRIAL_B,
          expect: "reject",
          tags: ["pk-collision", "other-user-id"],
          note: "OTHER user's trial id (PK)",
        }
      : r < 0.45
        ? uuidFor(rng, false)
        : { value: fresh, expect: "accept", tags: ["uuid-valid"], note: "fresh v4" };
  if (isSharedId(id)) id = { ...id, expect: "either" };
  const uid: Candidate =
    r >= 0.45 && r < 0.55
      ? {
          value: other(actor),
          expect: "reject",
          tags: ["rls", "spoof-uid"],
          note: "OTHER user's uid",
        }
      : { value: users[actor], expect: "accept", tags: ["own-uid"], note: "own uid" };
  const payload = jsonFor(rng, typeof id.value === "string" ? id.value : fresh);
  const createdAt: Candidate =
    r >= 0.55 && r < 0.65
      ? (() => {
          const t = timestampFor(rng, false, true);
          return t.value === null
            ? t
            : {
                ...t,
                policyGap: t.expect === "reject" ? undefined : "ledger_created_at_client_settable",
              };
        })()
      : { value: null, expect: "accept", tags: ["default"], note: "default now()" };
  const upsert = rng.bool(0.3); // the edge uses upsert ignoreDuplicates
  const collides = id.tags.includes("pk-collision");
  const { expect, report, gaps } = combine({ id, user_id: uid, payload, created_at: createdAt });
  const idValid = id.expect === "accept" && !collides;
  // ON CONFLICT DO NOTHING swallows the pk collision (0 rows, no write) — but
  // only after RLS WITH CHECK, casts and CHECK constraints have passed.
  const upsertExpect: Expect =
    uid.expect === "reject" || payload.expect === "reject" || createdAt.expect === "reject"
      ? "reject"
      : payload.expect === "either" || createdAt.expect === "either"
        ? "either"
        : "accept";
  return {
    surface: "evaluation_trials.insert",
    op: `${upsert ? "upsert-ignore" : "insert"} evaluation_trials`,
    actor,
    isolation,
    expect: upsert && collides ? upsertExpect : expect,
    fields: report,
    gaps,
    statement: `insert into public.evaluation_trials (id, user_id, payload, created_at)
       values ($1::text::uuid, $2::text::uuid, $3::text::jsonb, coalesce($4::text::timestamptz, now()))${upsert ? " on conflict (id) do nothing" : ""}`,
    params: [id.value, uid.value, payload.value, createdAt.value],
    probe: idValid
      ? {
          sql: `select count(*)::int as n from public.evaluation_trials where id = $1::text::uuid`,
          params: [id.value],
        }
      : null,
    acceptRows: upsert && collides ? 0 : 1,
  };
};

const feedbackInsert: SurfaceBuilder = (rng, actor, isolation): Plan => {
  const r = rng.next();
  if (r < 0.1) {
    const del = rng.bool();
    return {
      surface: "analysis_feedback.mutate",
      op: del ? "delete own feedback (append-only)" : "update own feedback rating (append-only)",
      actor,
      isolation,
      expect: "reject",
      fields: {
        ledger: {
          expect: "reject",
          tags: ["append-only", "grant"],
          note: del ? "DELETE" : "UPDATE",
        },
      },
      gaps: [],
      statement: del
        ? `delete from public.analysis_feedback where user_id = $1::text::uuid`
        : `update public.analysis_feedback set rating = 'x' where user_id = $1::text::uuid`,
      params: [users[actor]],
      probe: null,
    };
  }
  let analysis: Candidate =
    r < 0.2
      ? {
          value: ownRatedAnalysis(actor),
          expect: "reject",
          tags: ["unique", "duplicate"],
          note: "already rated by this user (unique analysis_id,user_id)",
        }
      : r < 0.28
        ? {
            value: ownRatedAnalysis(actor === "A" ? "B" : "A"),
            expect: "either",
            tags: ["unique", "other-user-rated"],
            note: "rated by the OTHER user (unique is per user; a second iteration of this user collides)",
          }
        : r < 0.5
          ? uuidFor(rng, false)
          : {
              value: rng.uuid(),
              expect: "accept",
              tags: ["uuid-valid"],
              note: "fresh analysis id (no FK by design)",
            };
  if (isSharedId(analysis)) analysis = { ...analysis, expect: "either" };
  const uid: Candidate =
    r >= 0.5 && r < 0.58
      ? {
          value: other(actor),
          expect: "reject",
          tags: ["rls", "spoof-uid"],
          note: "OTHER user's uid",
        }
      : { value: users[actor], expect: "accept", tags: ["own-uid"], note: "own uid" };
  const rating: Candidate =
    r >= 0.58 && r < 0.8
      ? textFor(rng, 50, false)
      : { value: rng.pick(["up", "down"]), expect: "accept", tags: ["vocab"], note: "up/down" };
  const category: Candidate =
    r >= 0.8 && r < 0.92
      ? textFor(rng, 50, true)
      : { value: null, expect: "accept", tags: ["null"], note: "NULL" };
  const createdAt: Candidate =
    r >= 0.92
      ? (() => {
          const t = timestampFor(rng, false, true);
          return t.value === null
            ? t
            : {
                ...t,
                policyGap: t.expect === "reject" ? undefined : "ledger_created_at_client_settable",
              };
        })()
      : { value: null, expect: "accept", tags: ["default"], note: "default now()" };
  const { expect, report, gaps } = combine({
    analysis_id: analysis,
    user_id: uid,
    rating,
    category,
    created_at: createdAt,
  });
  if (
    rating.expect === "accept" &&
    rating.value !== null &&
    !["up", "down"].includes(rating.value) &&
    expect !== "reject"
  ) {
    gaps.push("rating:feedback_rating_vocabulary_not_enforced");
  }
  const analysisValid = analysis.expect === "accept" && analysis.tags[0] !== "unique";
  return {
    surface: "analysis_feedback.insert",
    op: "insert analysis_feedback",
    actor,
    isolation,
    expect,
    fields: report,
    gaps,
    statement: `insert into public.analysis_feedback (analysis_id, user_id, rating, category, created_at)
       values ($1::text::uuid, $2::text::uuid, $3, $4, coalesce($5::text::timestamptz, now()))`,
    params: [analysis.value, uid.value, rating.value, category.value, createdAt.value],
    probe:
      analysisValid && uid.expect === "accept"
        ? {
            sql: `select count(*)::int as n from public.analysis_feedback where analysis_id = $1::text::uuid and user_id = $2::text::uuid`,
            params: [analysis.value, uid.value],
          }
        : null,
    acceptRows: 1,
  };
};

const RPC_CODES = new Set([
  "accepted",
  "shot.session_not_found",
  "shot.id_conflict",
  "access.permit_not_found",
  "access.permit_not_reserved",
  "access.permit_expired",
  "access.paywall_required",
  "auth.required",
]);

const rpcSync: SurfaceBuilder = (rng, actor, isolation): Plan => {
  const shotId = rng.uuid();
  const r = rng.next();
  const sessionId: Candidate =
    r < 0.15
      ? { value: ownSession(actor), expect: "accept", tags: ["own-session"], note: "own session" }
      : r < 0.3
        ? {
            value: otherSession(actor),
            expect: "accept",
            tags: ["rls", "other-user-session"],
            note: "OTHER user's session → shot.session_not_found",
          }
        : r < 0.4
          ? { value: "", expect: "accept", tags: ["empty"], note: "'' (nullif → null)" }
          : r < 0.5
            ? { value: null, expect: "accept", tags: ["null"], note: "null" }
            : uuidFor(rng, true);
  // text-column payload fuzz on the same call (shot_type is CHECK-bounded)
  const shotType: Candidate = rng.bool(0.3)
    ? textFor(rng, 64, false)
    : { value: "dink", expect: "accept", tags: ["plain"], note: "dink" };
  const capturedAt: Candidate = rng.bool(0.3)
    ? timestampFor(rng, true, false)
    : { value: "2026-09-01T10:00:00.000Z", expect: "accept", tags: ["iso-valid"], note: "iso" };
  const payload: Record<string, unknown> = {
    id: shotId,
    analysisPermitId: "__PERMIT__",
    sessionId: sessionId.value,
    shotType: shotType.value,
    cameraView: "side",
    capturedAt: capturedAt.value,
    startMs: 0,
    contactMs: 100,
    endMs: 200,
    overallScore: null,
    confidence: 0.4,
    resultKind: "low_confidence",
    phases: [],
    checkpoints: [],
    versionVector: { appVersion: "1.0.0" },
  };
  const { report, gaps } = combine({ sessionId, shotType, capturedAt });
  // RPC contract: a text code, never a raised error. The sessionId cast runs
  // OUTSIDE the function's exception block, so a malformed id is expected to
  // THROW 22P02 — recorded as a policy gap (edge validates first).
  const sessionMalformed = sessionId.expect === "reject";
  if (sessionMalformed) gaps.push("sessionId:rpc_cast_outside_exception_block");
  return {
    surface: "rpc.apply_synced_shot",
    op: "reserve permit + apply_synced_shot with fuzzed sessionId/shotType/capturedAt",
    actor,
    isolation,
    expect: sessionMalformed ? "either" : "accept",
    fields: report,
    gaps,
    statement: `select public.apply_synced_shot(replace($1, '"__PERMIT__"', to_jsonb((select x.permit_id from public.reserve_analysis_permit($2) x))::text)::jsonb) as code`,
    params: [JSON.stringify(payload), `stress-${shotId}`],
    probe: {
      sql: `select count(*)::int as n from public.shots where id = $1::text::uuid`,
      params: [shotId],
    },
    rpcKnownCodes: RPC_CODES,
  };
};

const rlsRead: SurfaceBuilder = (rng, actor, isolation): Plan => {
  const table = rng.pick(["sessions", "captures", "evaluation_trials", "analysis_feedback"]);
  const r = rng.next();
  if (r < 0.5) {
    return {
      surface: "rls.read",
      op: `select ${table} where user_id = OTHER`,
      actor,
      isolation,
      expect: "accept",
      fields: {
        filter: { expect: "accept", tags: ["rls", "other-user-rows"], note: "must return 0 rows" },
      },
      gaps: [],
      statement: `select count(*)::int as n from public.${table} where user_id = $1::text::uuid`,
      params: [other(actor)],
      probe: null,
      acceptRows: 0,
    };
  }
  const id = lookupId(uuidFor(rng, true));
  return {
    surface: "rls.read",
    op: `select ${table} where id = fuzz`,
    actor,
    isolation,
    expect: id.expect,
    fields: { id: { expect: id.expect, tags: id.tags, note: id.note } },
    gaps: [],
    statement: `select count(*)::int as n from public.${table} where id = $1::text::uuid`,
    params: [id.value],
    probe: null,
    acceptRows: 0,
  };
};

const bytesProbe: SurfaceBuilder = (rng, actor, isolation): Plan => {
  const b = invalidUtf8Hex(rng);
  const target = rng.pick([
    "sessions.notes",
    "sessions.kind",
    "analysis_feedback.rating",
    "evaluation_trials.payload",
  ]);
  const fresh = rng.uuid();
  const stmt =
    target === "sessions.notes"
      ? `insert into public.sessions (id, user_id, kind, started_at, notes) values ($2::text::uuid, $3::text::uuid, 'practice', '2026-09-01T10:00:00Z', convert_from(decode($1, 'hex'), 'UTF8'))`
      : target === "sessions.kind"
        ? `insert into public.sessions (id, user_id, kind, started_at) values ($2::text::uuid, $3::text::uuid, convert_from(decode($1, 'hex'), 'UTF8'), '2026-09-01T10:00:00Z')`
        : target === "analysis_feedback.rating"
          ? `insert into public.analysis_feedback (analysis_id, user_id, rating) values ($2::text::uuid, $3::text::uuid, convert_from(decode($1, 'hex'), 'UTF8'))`
          : `insert into public.evaluation_trials (id, user_id, payload) values ($2::text::uuid, $3::text::uuid, ('{"a":"' || convert_from(decode($1, 'hex'), 'UTF8') || '"}')::jsonb)`;
  return {
    surface: "bytes.invalid_utf8",
    op: `invalid UTF-8 into ${target}`,
    actor,
    isolation,
    expect: "reject",
    fields: { bytes: { expect: "reject", tags: b.tags, note: b.note } },
    gaps: [],
    statement: stmt,
    params: [b.value, fresh, users[actor]],
    probe: target.startsWith("sessions")
      ? {
          sql: `select count(*)::int as n from public.sessions where id = $1::text::uuid`,
          params: [fresh],
        }
      : target === "evaluation_trials.payload"
        ? {
            sql: `select count(*)::int as n from public.evaluation_trials where id = $1::text::uuid`,
            params: [fresh],
          }
        : {
            sql: `select count(*)::int as n from public.analysis_feedback where analysis_id = $1::text::uuid`,
            params: [fresh],
          },
  };
};

const SURFACES: Array<[number, SurfaceBuilder]> = [
  [26, sessionsInsert],
  [9, sessionsUpdate],
  [3, sessionsDelete],
  [8, capturesClientWrite],
  [7, capturesOwnerInsert],
  [18, trialsInsert],
  [13, feedbackInsert],
  [8, rpcSync],
  [4, rlsRead],
  [4, bytesProbe],
];
const TOTAL_WEIGHT = SURFACES.reduce((a, [w]) => a + w, 0);

function buildPlan(seed: number): Plan {
  const rng = new Prng(seed);
  let pick = rng.next() * TOTAL_WEIGHT;
  let builder = SURFACES[0][1];
  for (const [w, b] of SURFACES) {
    if (pick < w) {
      builder = b;
      break;
    }
    pick -= w;
  }
  const actor: Actor = rng.bool() ? "A" : "B";
  const isolation: Isolation = rng.bool(0.25) ? "serializable" : "read committed";
  return builder(rng, actor, isolation);
}

// ------------------------------------------------------------------ execution

interface ExecResult {
  outcome: IterationRow["outcome"];
  sqlstate: string | null;
  message: string | null;
  rows: number | null;
  rpcResult: string | null;
}

async function execute(sql: Sql, plan: Plan): Promise<ExecResult> {
  try {
    let rows: number | null = null;
    let rpcResult: string | null = null;
    await sql.begin(`isolation level ${plan.isolation}`, async (tx) => {
      if (plan.actor !== "owner") {
        await tx.unsafe(`set local role authenticated`);
        await tx.unsafe(`set local request.jwt.claim.sub = '${users[plan.actor]}'`);
        await tx.unsafe(
          `set local request.jwt.claims = '{"sub":"${users[plan.actor]}","role":"authenticated"}'`,
        );
      }
      const res = await tx.unsafe(plan.statement, plan.params as string[]);
      rows = res.count ?? res.length;
      if (plan.rpcKnownCodes) rpcResult = String(res[0]?.code ?? "");
      else if (plan.surface === "rls.read") rows = Number(res[0]?.n ?? -1);
    });
    return { outcome: "accepted", sqlstate: null, message: null, rows, rpcResult };
  } catch (e) {
    const err = e as { code?: string; message?: string; name?: string };
    const code = typeof err.code === "string" && /^[0-9A-Z]{5}$/.test(err.code) ? err.code : null;
    return {
      outcome: code ? "rejected" : "client_throw",
      sqlstate: code,
      message: String(err.message ?? err.name ?? e).slice(0, 160),
      rows: null,
      rpcResult: null,
    };
  }
}

async function probe(sql: Sql, plan: Plan): Promise<boolean | null | "probe_error"> {
  if (!plan.probe) return null;
  try {
    const r = await sql.unsafe(plan.probe.sql, plan.probe.params as string[]);
    return Number(r[0]?.n ?? 0) > 0;
  } catch {
    return "probe_error";
  }
}

function classify(
  plan: Plan,
  res: ExecResult,
  probed: boolean | null | "probe_error",
): { verdict: Verdict; reason: string } {
  if (probed === "probe_error") {
    return {
      verdict: "BROKEN",
      reason: "harness probe failed (oracle bug: probe id not castable)",
    };
  }
  const writeObserved = probed;
  if (res.outcome === "client_throw") {
    return { verdict: "BROKEN", reason: `client-side throw (no SQLSTATE): ${res.message}` };
  }
  if (res.outcome === "rejected") {
    const st = res.sqlstate!;
    if (!isGraceful(st, plan.isolation))
      return { verdict: "BROKEN", reason: `ungraceful SQLSTATE ${st}: ${res.message}` };
    if (writeObserved === true)
      return { verdict: "BROKEN", reason: `write observed after rejection ${st}` };
    if (plan.rpcKnownCodes) {
      if ((st === "40001" || st === "40P01") && plan.isolation === "serializable") {
        return {
          verdict: "HELD",
          reason: `serialization failure ${st} under SERIALIZABLE (retryable)`,
        };
      }
      if (st === "22P05") {
        // \u0000 inside the payload text: the jsonb literal itself is refused
        // before the RPC runs (jsonb cannot hold NUL) — typed, no write.
        return { verdict: "HELD", reason: "jsonb literal with \\u0000 refused before RPC (22P05)" };
      }
      if (st === "22P02" && plan.gaps.includes("sessionId:rpc_cast_outside_exception_block")) {
        return {
          verdict: "GAP",
          reason: `apply_synced_shot raised ${st} for malformed sessionId instead of returning a code`,
        };
      }
      return { verdict: "BROKEN", reason: `apply_synced_shot raised ${st}: ${res.message}` };
    }
    if (plan.expect === "accept") {
      if ((st === "40001" || st === "40P01") && plan.isolation === "serializable") {
        return {
          verdict: "HELD",
          reason: `serialization failure ${st} under SERIALIZABLE (retryable)`,
        };
      }
      return { verdict: "BROKEN", reason: `in-contract value rejected with ${st}: ${res.message}` };
    }
    return { verdict: "HELD", reason: `rejected ${st}` };
  }
  // accepted
  if (plan.rpcKnownCodes) {
    const code = res.rpcResult ?? "";
    if (!code) return { verdict: "BROKEN", reason: "RPC returned no code" };
    const known = plan.rpcKnownCodes.has(code) || code.startsWith("shot.write_failed:");
    if (!known) return { verdict: "BROKEN", reason: `unknown RPC code ${code}` };
    if (code.startsWith("shot.write_failed:") && writeObserved)
      return { verdict: "BROKEN", reason: `write_failed but shot row exists` };
    if (code === "accepted" && writeObserved === false)
      return { verdict: "BROKEN", reason: "accepted but shot row missing" };
    if (code !== "accepted" && writeObserved)
      return { verdict: "BROKEN", reason: `${code} but shot row exists` };
    // A raw shotType/capturedAt violation must surface as write_failed:<SQLSTATE>
    if (code.startsWith("shot.write_failed:")) {
      const st = code.slice("shot.write_failed:".length);
      if (!isGraceful(st, plan.isolation))
        return { verdict: "BROKEN", reason: `write_failed carries ungraceful ${st}` };
    }
    return { verdict: plan.gaps.length ? "GAP" : "HELD", reason: `rpc ${code}` };
  }
  if (plan.expect === "reject") {
    return {
      verdict: "BROKEN",
      reason: `malformed value ACCEPTED (rows=${res.rows}, writeObserved=${writeObserved})`,
    };
  }
  if (plan.expect === "accept") {
    if (plan.acceptRows !== undefined && res.rows !== null && res.rows !== plan.acceptRows) {
      return {
        verdict: "BROKEN",
        reason: `expected ${plan.acceptRows} rows affected, got ${res.rows}`,
      };
    }
    if (plan.acceptRows === 0 && writeObserved === true) {
      return { verdict: "BROKEN", reason: "RLS-filtered statement changed the other user's row" };
    }
    if (plan.acceptRows === 1 && writeObserved === false) {
      return { verdict: "BROKEN", reason: "accepted but row not found afterwards" };
    }
  }
  if (plan.gaps.length)
    return { verdict: "GAP", reason: `accepted; policy gaps: ${plan.gaps.join(", ")}` };
  return {
    verdict: "HELD",
    reason: plan.expect === "either" ? "accepted (contract silent)" : "accepted in-contract",
  };
}

async function runIteration(sql: Sql, i: number, seed: number): Promise<IterationRow> {
  const plan = buildPlan(seed);
  const t0 = performance.now();
  const res = await execute(sql, plan);
  const probed = await probe(sql, plan);
  const writeObserved = probed === "probe_error" ? null : probed;
  const { verdict, reason } = classify(plan, res, probed);
  return {
    i,
    seed,
    surface: plan.surface,
    op: plan.op,
    actor: plan.actor,
    isolation: plan.isolation,
    expect: plan.expect,
    fields: plan.fields,
    outcome: res.outcome,
    sqlstate: res.sqlstate,
    message: res.message,
    rows: res.rows,
    rpcResult: res.rpcResult,
    writeObserved,
    verdict,
    reason,
    gaps: plan.gaps,
    ms: Math.round((performance.now() - t0) * 100) / 100,
    replay: `STRESS_PG_URL=$STRESS_PG_URL STRESS_REPLAY=${seed} deno test -A --config deno.json boundary_malformed.test.ts`,
  };
}

function quoteLit(v: string | null): string {
  if (v === null) return "NULL";
  const cp = codepoints(v);
  if (cp > 200) return `/* ${describe(v)} */ '…'`;
  return `'${v.replace(/'/g, "''").split("\u0000").join("\\x00")}'`;
}

/** Exact SQL for a plan, for the report / minimized repro. */
function reproSql(plan: Plan): string {
  let s = plan.statement.replace(/\s+/g, " ").trim();
  for (let k = plan.params.length; k >= 1; k--) {
    s = s.replace(new RegExp(`\\$${k}(?![0-9])`, "g"), quoteLit(plan.params[k - 1]));
  }
  const head =
    plan.actor === "owner"
      ? `begin isolation level ${plan.isolation};`
      : `begin isolation level ${plan.isolation}; set local role authenticated; set local request.jwt.claim.sub = '${users[plan.actor]}'; set local request.jwt.claims = '{"sub":"${users[plan.actor]}","role":"authenticated"}';`;
  return `${head} ${s}; rollback;`;
}

// ------------------------------------------------------------------ fixtures

async function setupFixtures(sql: Sql) {
  for (const uid of [USER_A, USER_B]) {
    await sql.unsafe(`delete from auth.users where id = '${uid}'`);
    await sql.unsafe(
      `insert into auth.users (id, email, raw_app_meta_data) values ('${uid}', '${uid}@example.com', '{"provider":"google"}')`,
    );
    await sql.unsafe(
      `insert into public.billing_entitlements (user_id, premium) values ('${uid}', true)`,
    );
  }
  await sql.unsafe(
    `insert into public.sessions (id, user_id, kind, started_at) values
       ('${SESSION_A}', '${USER_A}', 'practice', '2026-09-01T09:00:00Z'),
       ('${SESSION_B}', '${USER_B}', 'game', '2026-09-01T09:00:00Z'),
       ('${SESSION_A_END}', '${USER_A}', 'practice', '2026-09-01T09:00:00Z'),
       ('${SESSION_B_END}', '${USER_B}', 'game', '2026-09-01T09:00:00Z')`,
  );
  await sql.unsafe(
    `insert into public.evaluation_trials (id, user_id, payload) values ('${TRIAL_B}', '${USER_B}', '{"schemaVersion":"evaluation-trial-v1"}')`,
  );
  await sql.unsafe(
    `insert into public.analysis_feedback (analysis_id, user_id, rating) values
       ('${ANALYSIS_A}', '${USER_A}', 'up'), ('${ANALYSIS_B}', '${USER_B}', 'down')`,
  );
}

interface Invariant {
  name: string;
  sql: string;
  /** expected scalar */
  expect: string;
  actor?: Actor;
}

const INVARIANTS: Invariant[] = [
  {
    name: "sessions owned only by A/B",
    expect: "0",
    sql: `select count(*)::text from public.sessions where user_id not in ('${USER_A}','${USER_B}')`,
  },
  {
    name: "captures owned only by A/B",
    expect: "0",
    sql: `select count(*)::text from public.captures where user_id not in ('${USER_A}','${USER_B}')`,
  },
  {
    name: "evaluation_trials owned only by A/B",
    expect: "0",
    sql: `select count(*)::text from public.evaluation_trials where user_id not in ('${USER_A}','${USER_B}')`,
  },
  {
    name: "analysis_feedback owned only by A/B",
    expect: "0",
    sql: `select count(*)::text from public.analysis_feedback where user_id not in ('${USER_A}','${USER_B}')`,
  },
  {
    name: "sessions.notes within 4000 codepoints",
    expect: "0",
    sql: `select count(*)::text from public.sessions where length(notes) > 4000`,
  },
  {
    name: "sessions.kind within vocabulary",
    expect: "0",
    sql: `select count(*)::text from public.sessions where kind not in ('practice','game')`,
  },
  {
    name: "sessions.event_count non-negative",
    expect: "0",
    sql: `select count(*)::text from public.sessions where event_count < 0`,
  },
  {
    name: "captures text bounds",
    expect: "0",
    sql: `select count(*)::text from public.captures where length(capture_mode) > 64 or coalesce(length(declared_stroke),0) > 64`,
  },
  {
    name: "captures captured_at within [2000,2100)",
    expect: "0",
    sql: `select count(*)::text from public.captures where captured_at < '2000-01-01' or captured_at >= '2100-01-01'`,
  },
  {
    name: "captures unit-interval metrics",
    expect: "0",
    sql: `select count(*)::text from public.captures where joint_coverage < 0 or joint_coverage > 1 or pose_availability < 0 or pose_availability > 1`,
  },
  {
    name: "evaluation_trials payload <= 262144 bytes",
    expect: "0",
    sql: `select count(*)::text from public.evaluation_trials where pg_column_size(payload) > 262144`,
  },
  {
    name: "analysis_feedback bounds",
    expect: "0",
    sql: `select count(*)::text from public.analysis_feedback where length(rating) > 50 or coalesce(length(category),0) > 50`,
  },
  {
    name: "analysis_feedback unique (analysis_id,user_id)",
    expect: "0",
    sql: `select count(*)::text from (select analysis_id, user_id from public.analysis_feedback group by 1,2 having count(*) > 1) d`,
  },
  {
    name: "fixture sessions untouched (ended_at null, both present)",
    expect: "2",
    sql: `select count(*)::text from public.sessions where id in ('${SESSION_A}','${SESSION_B}') and ended_at is null`,
  },
  {
    name: "RLS: A sees none of B's sessions",
    expect: "0",
    actor: "A",
    sql: `select count(*)::text from public.sessions where user_id = '${USER_B}'`,
  },
  {
    name: "RLS: A sees none of B's captures",
    expect: "0",
    actor: "A",
    sql: `select count(*)::text from public.captures where user_id = '${USER_B}'`,
  },
  {
    name: "RLS: A sees none of B's trials",
    expect: "0",
    actor: "A",
    sql: `select count(*)::text from public.evaluation_trials where user_id = '${USER_B}'`,
  },
  {
    name: "RLS: A sees none of B's feedback",
    expect: "0",
    actor: "A",
    sql: `select count(*)::text from public.analysis_feedback where user_id = '${USER_B}'`,
  },
  {
    name: "RLS: B sees none of A's sessions",
    expect: "0",
    actor: "B",
    sql: `select count(*)::text from public.sessions where user_id = '${USER_A}'`,
  },
  {
    name: "RLS: B sees none of A's trials",
    expect: "0",
    actor: "B",
    sql: `select count(*)::text from public.evaluation_trials where user_id = '${USER_A}'`,
  },
  {
    name: "RLS: B sees none of A's feedback",
    expect: "0",
    actor: "B",
    sql: `select count(*)::text from public.analysis_feedback where user_id = '${USER_A}'`,
  },
  {
    name: "RLS: A sees only own rows (sessions)",
    expect: "0",
    actor: "A",
    sql: `select count(*)::text from public.sessions where user_id <> '${USER_A}'`,
  },
  {
    name: "shots reference only owner-visible sessions",
    expect: "0",
    sql: `select count(*)::text from public.shots s join public.sessions se on se.id = s.session_id where se.user_id <> s.user_id`,
  },
];

async function checkInvariants(
  sql: Sql,
): Promise<Array<{ name: string; ok: boolean; got: string }>> {
  const out: Array<{ name: string; ok: boolean; got: string }> = [];
  for (const inv of INVARIANTS) {
    let got = "";
    if (inv.actor) {
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local role authenticated`);
        await tx.unsafe(`set local request.jwt.claim.sub = '${users[inv.actor!]}'`);
        const r = await tx.unsafe(inv.sql);
        got = String(Object.values(r[0])[0]);
      });
    } else {
      const r = await sql.unsafe(inv.sql);
      got = String(Object.values(r[0])[0]);
    }
    out.push({ name: inv.name, ok: got === inv.expect, got });
  }
  return out;
}

/** Owner-side measurement for the size-probe gap: text length vs jsonb bytes. */
async function measureSizeProbes(
  sql: Sql,
  rows: IterationRow[],
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (
      row.surface !== "evaluation_trials.insert" ||
      !row.fields.payload?.tags.includes("size-probe")
    )
      continue;
    const plan = buildPlan(row.seed);
    const text = plan.params[2]!;
    let jsonbBytes: number | null = null;
    try {
      const r = await sql.unsafe(`select pg_column_size($1::text::jsonb)::int as n`, [text]);
      jsonbBytes = Number(r[0].n);
    } catch {
      jsonbBytes = null;
    }
    const otherFieldsAccept = Object.entries(row.fields).every(
      ([k, f]) => k === "payload" || f.expect === "accept",
    );
    out.push({
      seed: row.seed,
      note: row.fields.payload.note,
      /** the payload is the only non-accepting field, so the sqlstate below
       * is attributable to it */
      payloadAttributable: otherFieldsAccept,
      textLength: text.length,
      utf8Bytes: utf8Bytes(text),
      jsonbBytes,
      underEdgeCap250000: text.length <= 250000,
      overDbCap262144: jsonbBytes !== null && jsonbBytes > 262144,
      edgeAcceptsDbRejects: text.length <= 250000 && jsonbBytes !== null && jsonbBytes > 262144,
      sqlstate: row.sqlstate,
      verdict: row.verdict,
    });
  }
  return out;
}

// ------------------------------------------------------------------ tests

Deno.test({
  name: `db-sessions-captures boundary/malformed campaign (iter=${ITER}, seed=${SEED}, lanes=${LANES})`,
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    await Deno.mkdir(OUT_DIR, { recursive: true });
    const sql = postgres(PG_URL, {
      max: LANES + 4,
      onnotice: () => {},
      idle_timeout: 5,
      connect_timeout: 30,
    });
    try {
      await setupFixtures(sql);

      if (REPLAY) {
        const seed = Number(REPLAY) >>> 0;
        const row = await runIteration(sql, 0, seed);
        const plan = buildPlan(seed);
        console.log(JSON.stringify({ ...row, repro_sql: reproSql(plan) }, null, 2));
        assert(row.verdict !== "BROKEN", `replayed seed ${seed} is BROKEN: ${row.reason}`);
        return;
      }

      const rows: IterationRow[] = new Array(ITER);
      let next = 0;
      const t0 = performance.now();
      await Promise.all(
        Array.from({ length: LANES }, async () => {
          for (;;) {
            const i = next++;
            if (i >= ITER) return;
            rows[i] = await runIteration(sql, i, iterSeed(SEED, i));
          }
        }),
      );
      const wallMs = Math.round(performance.now() - t0);

      const broken = rows.filter((r) => r.verdict === "BROKEN");
      const gapRows = rows.filter((r) => r.verdict === "GAP");

      // Flaky check: every BROKEN seed re-runs FLAKY_RERUNS times serially.
      const reruns: Array<{ seed: number; brokenRate: string; reasons: string[] }> = [];
      for (const b of broken) {
        let again = 0;
        const reasons = new Set<string>();
        for (let k = 0; k < FLAKY_RERUNS; k++) {
          const r = await runIteration(sql, b.i, b.seed);
          if (r.verdict === "BROKEN") again++;
          reasons.add(r.reason);
        }
        reruns.push({
          seed: b.seed,
          brokenRate: `${again}/${FLAKY_RERUNS}`,
          reasons: [...reasons],
        });
      }

      const invariants = await checkInvariants(sql);
      const sizeProbes = await measureSizeProbes(sql, rows);

      const count = <K extends string>(f: (r: IterationRow) => K) =>
        rows.reduce((m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {} as Record<string, number>);
      const gapCounts: Record<string, { n: number; seeds: number[]; surfaces: Set<string> }> = {};
      for (const r of gapRows) {
        for (const g of r.gaps) {
          gapCounts[g] ??= { n: 0, seeds: [], surfaces: new Set() };
          gapCounts[g].n++;
          if (gapCounts[g].seeds.length < 5) gapCounts[g].seeds.push(r.seed);
          gapCounts[g].surfaces.add(r.surface);
        }
      }
      const tagCounts: Record<string, number> = {};
      for (const r of rows) {
        for (const f of Object.values(r.fields))
          for (const tg of f.tags) tagCounts[tg] = (tagCounts[tg] ?? 0) + 1;
      }

      const report = {
        harness: "supabase/tests/stress/boundary_malformed.test.ts",
        config: {
          ITER,
          SEED,
          LANES,
          PG: PG_URL.replace(/\/\/.*@/, "//<redacted>@"),
          users: { A: USER_A, B: USER_B },
        },
        executed: rows.length,
        wallMs,
        verdicts: count((r) => r.verdict),
        outcomes: count((r) => r.outcome),
        bySurface: count((r) => r.surface),
        byIsolation: count((r) => r.isolation),
        byActor: count((r) => r.actor),
        bySqlstate: count(
          (r) => r.sqlstate ?? (r.rpcResult ? `rpc:${r.rpcResult.split(":")[0]}` : "accepted"),
        ),
        byExpect: count((r) => r.expect),
        tagCoverage: tagCounts,
        policyGaps: Object.fromEntries(
          Object.entries(gapCounts).map(([k, v]) => [
            k,
            { n: v.n, exampleSeeds: v.seeds, surfaces: [...v.surfaces] },
          ]),
        ),
        broken: broken.map((b) => ({ ...b, repro_sql: reproSql(buildPlan(b.seed)) })),
        flakyReruns: reruns,
        invariants,
        sizeProbes,
        replayCommand:
          "STRESS_PG_URL=... STRESS_REPLAY=<seed> deno test -A --config deno.json boundary_malformed.test.ts",
      };
      await Deno.writeTextFile(
        `${OUT_DIR}/boundary_malformed.summary.json`,
        JSON.stringify(report, null, 2),
      );
      await Deno.writeTextFile(
        `${OUT_DIR}/boundary_malformed.iterations.jsonl`,
        rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      );
      const gapExamples = gapRows.slice(0, 200).map((r) => ({
        seed: r.seed,
        surface: r.surface,
        gaps: r.gaps,
        reason: r.reason,
        repro_sql: reproSql(buildPlan(r.seed)),
      }));
      await Deno.writeTextFile(
        `${OUT_DIR}/boundary_malformed.gaps.json`,
        JSON.stringify(gapExamples, null, 2),
      );

      console.log(
        `\n[stress] executed=${rows.length} wall=${wallMs}ms verdicts=${JSON.stringify(report.verdicts)} outcomes=${JSON.stringify(
          report.outcomes,
        )}\n[stress] policy gaps: ${JSON.stringify(report.policyGaps)}\n[stress] report: ${OUT_DIR}/boundary_malformed.summary.json`,
      );

      await t.step("every iteration executed", () => {
        assertEquals(rows.filter(Boolean).length, ITER);
      });
      await t.step(
        "no BROKEN iteration (typed rejection, no write after reject, in-contract accepted)",
        () => {
          assertEquals(
            broken.length,
            0,
            `BROKEN seeds: ${broken.map((b) => `${b.seed} [${b.surface}] ${b.reason}`).join("\n")}`,
          );
        },
      );
      await t.step("no client-library throw / no ungraceful SQLSTATE", () => {
        assertEquals(rows.filter((r) => r.outcome === "client_throw").length, 0);
        const ungraceful = rows.filter((r) => r.sqlstate && !isGraceful(r.sqlstate, r.isolation));
        assertEquals(
          ungraceful.length,
          0,
          JSON.stringify(ungraceful.map((r) => [r.seed, r.sqlstate, r.message])),
        );
      });
      await t.step("global invariants after the campaign", () => {
        const failed = invariants.filter((i) => !i.ok);
        assertEquals(failed.length, 0, JSON.stringify(failed));
      });
      await t.step("both users and both isolation levels exercised", () => {
        assert((report.byActor.A ?? 0) > 0 && (report.byActor.B ?? 0) > 0);
        assert(
          (report.byIsolation["serializable"] ?? 0) > 0 &&
            (report.byIsolation["read committed"] ?? 0) > 0,
        );
      });
      await t.step("lens categories all generated", () => {
        for (const tag of [
          "truncated",
          "wrong-type",
          "proto-key",
          "overflow",
          "nan",
          "infinity",
          "neg-zero",
          "nul",
          "64k",
          "path-traversal",
          "future-schema",
          "empty-object",
          "empty-array",
          "unicode-normalization",
          "grapheme-cluster",
          "bytes",
        ]) {
          assert(
            (tagCounts[tag] ?? 0) > 0,
            `lens category '${tag}' never generated at ITER=${ITER}`,
          );
        }
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
});

Deno.test({
  name: "generators: candidates carry oracle + measurable dimensions",
  fn() {
    const rng = new Prng(7);
    for (let i = 0; i < 200; i++) {
      const c = textFor(rng, 64, true);
      if (c.value !== null) {
        assert(utf8Bytes(c.value) >= codepoints(c.value));
        assert(codepoints(c.value) >= graphemes(c.value));
      }
      assert(["accept", "reject", "either"].includes(c.expect));
    }
    // same seed → same plan (replayability)
    const a = buildPlan(123456);
    const b = buildPlan(123456);
    assertEquals(JSON.stringify(a.params), JSON.stringify(b.params));
    assertEquals(a.surface, b.surface);
  },
});
