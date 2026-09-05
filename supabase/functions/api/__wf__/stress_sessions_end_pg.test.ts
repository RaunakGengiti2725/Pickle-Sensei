// stress fuzz-boundary — POST /v1/sessions/:id/finalize — REAL Postgres half.
//
// stress_sessions_end_fuzz.test.ts proves the handler over a *modelled*
// PostgREST. This file runs the same REAL in-process handler, but every
// PostgREST call it makes to `sessions` is translated into SQL executed on a
// disposable postgres:16 with shim_auth.sql + every migration applied
// (./xc_pg_up.sh), one transaction per PostgREST request as role
// `authenticated` with the caller's JWT sub — the way PostgREST runs it, so
// RLS, the column-level UPDATE grant (ended_at only) and the updated_at
// trigger are the real ones, and the handler's read-then-write is a real race.
//
//   ./xc_pg_up.sh                      # prints XC_PG_URL
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     STRESS_PG_OUT=/tmp/finalize-pg.json \
//     deno test -A --no-check --config deno.json stress_sessions_end_pg.test.ts
//
// Without XC_PG_URL (alias: PICKLE_AUDIT_PG_URL) every test is `ignore`d —
// an ignored run is NOT a pass.
//
// Knobs: STRESS_PG_SEED (default 20260905), STRESS_PG_ITER (seeded mixed
// campaign, default 200), STRESS_PG_LANES (concurrent duplicate deliveries per
// round, default 16), STRESS_PG_ROUNDS (default 5), STRESS_PG_OUT (JSON).

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import { fakeGoogleIdToken, loadHarness, SUPABASE_URL } from "./routesHarness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
const SEED = envInt("STRESS_PG_SEED", 20260905);
const ITER = envInt("STRESS_PG_ITER", 200);
const LANES = envInt("STRESS_PG_LANES", 16);
const ROUNDS = envInt("STRESS_PG_ROUNDS", 5);
const OUT = Deno.env.get("STRESS_PG_OUT");

type Sql = ReturnType<typeof postgres>;

// ───────────────────────────── seeded RNG (same family as the fuzz file) ─────────────────────────────

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
class Rng {
  readonly next: () => number;
  constructor(seed: number) {
    this.next = prng(seed);
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  hex(n: number): string {
    let out = "";
    for (let i = 0; i < n; i += 1) out += "0123456789abcdef"[this.int(16)];
    return out;
  }
  uuidV4(): string {
    return `${this.hex(8)}-${this.hex(4)}-4${this.hex(3)}-${this.pick(["8", "9", "a", "b"])}${this.hex(3)}-${this.hex(12)}`;
  }
}

// ───────────────────────────── PostgREST → SQL translation ─────────────────────────────

interface DbCall {
  method: string;
  url: string;
  sub: string | null;
  sqlMs: number;
  status: number;
  rows: number | null;
  /** PATCH payload (what the handler asked PostgREST to write). */
  body?: Record<string, unknown>;
  error?: string;
}

const COLUMN_RE = /^[a-z_][a-z0-9_]*$/;

function postgrestError(status: number, code: string, message: string, details = ""): Response {
  return new Response(JSON.stringify({ code, message, details, hint: null }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** The bearer supabase-js forwards to PostgREST is the Supabase ACCESS token
 * the harness's Auth stub minted for the caller (`session-for-<sub>` for a
 * provider ID token exchanged transitionally); a real session JWT carries the
 * same identity in `sub`. Either way this is the identity PostgREST would set
 * as request.jwt.claim.sub. */
function subFromBearer(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token.startsWith("session-for-")) return token.slice("session-for-".length);
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const padded =
      parts[1].replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Install a fetch that answers PostgREST `sessions` traffic from Postgres
 * and forwards everything else (Supabase Auth stubs) to the harness fetch. */
function installPgBridge(sql: Sql, resolveSub: (req: Request) => string | null) {
  const base = globalThis.fetch;
  const calls: DbCall[] = [];
  const bridged = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (!url.href.startsWith(`${SUPABASE_URL}/rest/v1/`)) return base(input, init);
    const table = url.pathname.slice("/rest/v1/".length);
    if (table !== "sessions") {
      throw new Error(`unexpected PostgREST table from finalize route: ${table}`);
    }
    const sub = resolveSub(req);
    const started = performance.now();
    let patchBody: Record<string, unknown> | undefined;
    const record = (status: number, rows: number | null, error?: string) => {
      calls.push({
        method: req.method,
        url: req.url,
        sub,
        sqlMs: Math.round((performance.now() - started) * 100) / 100,
        status,
        rows,
        body: patchBody,
        error,
      });
    };
    if (!sub) {
      record(401, null, "no sub");
      return postgrestError(401, "PGRST301", "JWT has no sub");
    }
    const filters: Array<{ column: string; value: string }> = [];
    let select = "*";
    for (const [k, v] of url.searchParams) {
      if (k === "select") {
        select = v;
        continue;
      }
      if (!COLUMN_RE.test(k) || !v.startsWith("eq.")) {
        record(500, null, `unsupported filter ${k}=${v}`);
        return postgrestError(500, "BRIDGE", `unsupported filter ${k}=${v}`);
      }
      filters.push({ column: k, value: v.slice(3) });
    }
    const where = filters.map((f, i) => `"${f.column}" = $${i + 1}`).join(" and ");
    const params = filters.map((f) => f.value);

    try {
      if (req.method === "GET" || req.method === "HEAD") {
        const columns = select.split(",").map((c) => c.trim());
        if (!columns.every((c) => c === "*" || COLUMN_RE.test(c))) {
          record(500, null, `unsupported select ${select}`);
          return postgrestError(500, "BRIDGE", `unsupported select ${select}`);
        }
        const rows = await sql.begin(async (tx) => {
          await tx.unsafe(`set local role authenticated`);
          await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [sub]);
          return await tx.unsafe(
            `select ${columns.map((c) => (c === "*" ? "*" : `"${c}"`)).join(", ")} from public.sessions${where ? ` where ${where}` : ""}`,
            params,
          );
        });
        const accept = req.headers.get("accept") ?? "";
        const list = Array.from(rows as unknown as Iterable<Record<string, unknown>>);
        record(200, list.length);
        if (accept.includes("vnd.pgrst.object")) {
          if (list.length !== 1) {
            return postgrestError(
              406,
              "PGRST116",
              `JSON object requested, multiple (or no) rows returned`,
              `The result contains ${list.length} rows`,
            );
          }
          return new Response(JSON.stringify(list[0]), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }
        return new Response(JSON.stringify(list), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      if (req.method === "PATCH") {
        const body = JSON.parse(await req.text()) as Record<string, unknown>;
        patchBody = body;
        const keys = Object.keys(body);
        if (keys.length === 0 || !keys.every((k) => COLUMN_RE.test(k))) {
          record(400, null, `bad patch keys ${keys.join(",")}`);
          return postgrestError(400, "PGRST102", `bad patch keys ${keys.join(",")}`);
        }
        const sets = keys.map((k, i) => `"${k}" = $${filters.length + i + 1}`).join(", ");
        const values = keys.map((k) => body[k] as string);
        const result = await sql.begin(async (tx) => {
          await tx.unsafe(`set local role authenticated`);
          await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [sub]);
          return await tx.unsafe(
            `update public.sessions set ${sets}${where ? ` where ${where}` : ""} returning id`,
            [...params, ...values],
          );
        });
        const affected = Array.from(result as unknown as Iterable<unknown>).length;
        const prefer = req.headers.get("prefer") ?? "";
        record(prefer.includes("return=representation") ? 200 : 204, affected);
        if (prefer.includes("return=representation")) {
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }
        return new Response(null, {
          status: 204,
          headers: { "content-range": `0-${Math.max(0, affected - 1)}/*` },
        });
      }
      record(405, null, `unsupported method ${req.method}`);
      return postgrestError(405, "BRIDGE", `unsupported method ${req.method}`);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      // PostgREST maps insufficient_privilege to 403 and other SQL errors to 400/500.
      const status =
        e.code === "42501" ? 403 : e.code?.startsWith("22") || e.code?.startsWith("23") ? 400 : 500;
      record(status, null, `${e.code ?? "?"} ${e.message ?? String(err)}`);
      return postgrestError(status, e.code ?? "XX000", e.message ?? String(err));
    }
  };
  globalThis.fetch = bridged as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = base;
    },
  };
}

// ───────────────────────────── fixtures ─────────────────────────────

async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = $1`, [userId]);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, '{"provider":"google"}')`,
    [userId, `${userId}@example.com`],
  );
}

async function createSession(
  sql: Sql,
  sessionId: string,
  userId: string,
  endedAt: string | null,
): Promise<void> {
  await sql.unsafe(
    `insert into public.sessions (id, user_id, started_at, ended_at) values ($1, $2, now() - interval '1 hour', $3)`,
    [sessionId, userId, endedAt],
  );
}

interface SessionRow {
  id: string;
  user_id: string;
  ended_at: string | null;
  updated_at: string;
}

async function readSession(sql: Sql, sessionId: string): Promise<SessionRow | null> {
  const rows = await sql.unsafe(
    `select id, user_id::text, to_char(ended_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ended_at,
            to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
       from public.sessions where id = $1`,
    [sessionId],
  );
  const list = Array.from(rows as unknown as Iterable<SessionRow>);
  return list[0] ?? null;
}

/** Owner-role checksum of every row belonging to `userIds` (order-stable). */
async function checksum(sql: Sql, userIds: string[]): Promise<string> {
  const rows = await sql.unsafe(
    `select coalesce(md5(string_agg(s::text, '|' order by s.id)), 'empty') as h
       from public.sessions s where s.user_id = any($1::uuid[])`,
    [userIds],
  );
  return Array.from(rows as unknown as Iterable<{ h: string }>)[0].h;
}

function finalizeRequest(sessionIdRaw: string, userSub: string, requestId?: string): Request {
  return new Request(`http://edge.test/functions/v1/api/v1/sessions/${sessionIdRaw}/finalize`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${fakeGoogleIdToken(userSub)}`,
      "content-type": "application/json",
      "x-forwarded-for": `10.77.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
    body: "{}",
  });
}

const report: Record<string, unknown> = {
  seed: SEED,
  iter: ITER,
  lanes: LANES,
  rounds: ROUNDS,
  scenarios: {},
};
const scenarios = report.scenarios as Record<string, unknown>;

async function flush(): Promise<void> {
  if (OUT) await Deno.writeTextFile(OUT, JSON.stringify(report, null, 1));
}

// ───────────────────────────── tests ─────────────────────────────

Deno.test({
  name: "stress PG1: finalize on an OPEN session stamps ended_at once (RLS + ended_at-only grant + updated_at trigger are real)",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    const h = await loadHarness();
    const bridge = installPgBridge(sql, subFromBearer);
    const restoreLog = captureAccessLog(() => {});
    try {
      const rng = new Rng(SEED ^ 0x01);
      const user = rng.uuidV4();
      const session = rng.uuidV4();
      await createUser(sql, user);
      await createSession(sql, session, user, null);
      const before = await readSession(sql, session);
      assert(before && before.ended_at === null, "precondition: open");
      const res = await h.handler(finalizeRequest(session, user, "pg1-open"));
      const body = await res.text();
      const after = await readSession(sql, session);
      assertEquals(res.status, 200, body);
      assertEquals(res.headers.get("x-request-id"), "pg1-open");
      assert(after && after.ended_at !== null, "ended_at stamped");
      assert(after!.updated_at > before!.updated_at, "updated_at trigger fired");
      const patches = bridge.calls.filter((c) => c.method === "PATCH");
      assertEquals(patches.length, 1, "exactly one UPDATE");
      assertEquals(patches[0].rows, 1, "the UPDATE touched exactly one row");
      scenarios.PG1 = { user, session, status: res.status, before, after, calls: bridge.calls };
      await flush();
    } finally {
      restoreLog();
      bridge.restore();
      await sql.end();
    }
  },
});

Deno.test({
  name: "stress PG2: replaying finalize on an ENDED session is 200 with ZERO writes; ended_at is byte-identical after 25 replays",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    const h = await loadHarness();
    const bridge = installPgBridge(sql, subFromBearer);
    const restoreLog = captureAccessLog(() => {});
    try {
      const rng = new Rng(SEED ^ 0x02);
      const user = rng.uuidV4();
      const session = rng.uuidV4();
      await createUser(sql, user);
      await createSession(sql, session, user, null);
      const first = await h.handler(finalizeRequest(session, user));
      await first.body?.cancel();
      assertEquals(first.status, 200);
      const stamped = await readSession(sql, session);
      assert(stamped?.ended_at, "stamped");
      const statuses: number[] = [];
      for (let i = 0; i < 25; i += 1) {
        const res = await h.handler(finalizeRequest(session, user, `pg2-replay-${i}`));
        statuses.push(res.status);
        await res.body?.cancel();
      }
      const final = await readSession(sql, session);
      assertEquals(statuses, Array(25).fill(200), "replays are 200");
      assertEquals(final?.ended_at, stamped.ended_at, "ended_at never moved");
      assertEquals(
        final?.updated_at,
        stamped.updated_at,
        "updated_at never moved (no UPDATE issued)",
      );
      const patches = bridge.calls.filter((c) => c.method === "PATCH");
      assertEquals(patches.length, 1, "one UPDATE total (the first finalize)");
      scenarios.PG2 = {
        user,
        session,
        statuses,
        stamped,
        final,
        patchCount: patches.length,
        selectCount: bridge.calls.length - patches.length,
      };
      await flush();
    } finally {
      restoreLog();
      bridge.restore();
      await sql.end();
    }
  },
});

Deno.test({
  name: `stress PG3: ${LANES} CONCURRENT duplicate deliveries × ${ROUNDS} rounds on one open session — all 200, row ends exactly once (measure duplicate UPDATEs and ended_at drift)`,
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(PG_URL, { max: Math.max(8, LANES + 2) });
    const h = await loadHarness();
    const bridge = installPgBridge(sql, subFromBearer);
    const restoreLog = captureAccessLog(() => {});
    try {
      const rng = new Rng(SEED ^ 0x03);
      const rounds: unknown[] = [];
      let roundsWithDuplicateUpdates = 0;
      let roundsWhereEndedAtDrifted = 0;
      for (let r = 0; r < ROUNDS; r += 1) {
        const user = rng.uuidV4();
        const session = rng.uuidV4();
        await createUser(sql, user);
        await createSession(sql, session, user, null);
        const callsBefore = bridge.calls.length;
        const responses = await Promise.all(
          Array.from({ length: LANES }, (_, lane) =>
            h.handler(finalizeRequest(session, user, `pg3-r${r}-l${lane}`)),
          ),
        );
        const statuses: number[] = [];
        for (const res of responses) {
          statuses.push(res.status);
          await res.body?.cancel();
        }
        const roundCalls = bridge.calls.slice(callsBefore);
        const patches = roundCalls.filter((c) => c.method === "PATCH");
        const patchRows = patches.map((c) => c.rows);
        const row = await readSession(sql, session);
        // Every UPDATE carries its own new Date().toISOString(); with >1 the
        // last writer's timestamp wins, so ended_at can differ from the first
        // stamp the client was told about.
        const stamps = patches
          .map((c) => String(c.body?.ended_at ?? ""))
          .filter(Boolean)
          .sort();
        const finalMs = row?.ended_at ? Date.parse(row.ended_at) : NaN;
        const driftMs = stamps.length ? finalMs - Date.parse(stamps[0]) : 0;
        const drifted = stamps.length > 1 && driftMs !== 0;
        if (patches.length > 1) roundsWithDuplicateUpdates += 1;
        if (drifted) roundsWhereEndedAtDrifted += 1;
        rounds.push({
          round: r,
          user,
          session,
          statuses,
          patchCount: patches.length,
          patchRows,
          endedAt: row?.ended_at,
          updatedAt: row?.updated_at,
          stamps,
          driftMs,
          drifted,
        });
        assertEquals(
          statuses,
          Array(LANES).fill(200),
          `round ${r}: every duplicate delivery is 200`,
        );
        assert(row?.ended_at, `round ${r}: session ended`);
        assertEquals(
          new Set(patches.map((c) => c.sub)).size,
          patches.length ? 1 : 0,
          `round ${r}: every UPDATE scoped to the owner`,
        );
      }
      scenarios.PG3 = {
        rounds,
        roundsWithDuplicateUpdates,
        roundsWhereEndedAtDrifted,
        lanes: LANES,
      };
      await flush();
      console.log(
        JSON.stringify({
          PG3: {
            roundsWithDuplicateUpdates,
            roundsWhereEndedAtDrifted,
            rounds: ROUNDS,
            lanes: LANES,
            perRound: rounds.map((x) => {
              const y = x as { patchCount: number; driftMs: number };
              return { patchCount: y.patchCount, driftMs: y.driftMs };
            }),
          },
        }),
      );
    } finally {
      restoreLog();
      bridge.restore();
      await sql.end();
    }
  },
});

Deno.test({
  name: "stress PG4: another user's finalize of an open session is 404 with ZERO writes; owner's row untouched (RLS)",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    const h = await loadHarness();
    const bridge = installPgBridge(sql, subFromBearer);
    const restoreLog = captureAccessLog(() => {});
    try {
      const rng = new Rng(SEED ^ 0x04);
      const owner = rng.uuidV4();
      const intruder = rng.uuidV4();
      const session = rng.uuidV4();
      await createUser(sql, owner);
      await createUser(sql, intruder);
      await createSession(sql, session, owner, null);
      const sumBefore = await checksum(sql, [owner, intruder]);
      const res = await h.handler(finalizeRequest(session, intruder, "pg4-intruder"));
      const body = await res.text();
      const sumAfter = await checksum(sql, [owner, intruder]);
      const row = await readSession(sql, session);
      assertEquals(res.status, 404, body);
      assertEquals(JSON.parse(body).error.code, "session.not_found");
      assertEquals(bridge.calls.filter((c) => c.method === "PATCH").length, 0, "no UPDATE");
      assertEquals(row?.ended_at, null, "owner's session still open");
      assertEquals(sumAfter, sumBefore, "no row changed");
      assert(!body.includes(owner) && !body.includes(session), "no identifiers leak");
      scenarios.PG4 = {
        owner,
        intruder,
        session,
        status: res.status,
        body: JSON.parse(body),
        calls: bridge.calls,
      };
      await flush();
    } finally {
      restoreLog();
      bridge.restore();
      await sql.end();
    }
  },
});

type PgKind = "own-open" | "own-ended" | "other-open" | "missing" | "malformed-id";

Deno.test({
  name: `stress PG5: ${ITER} seeded mixed finalizes (own-open / own-ended / other's / missing / malformed) — oracle statuses, writes only on own-open, checksum otherwise stable`,
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(PG_URL, { max: 8 });
    const h = await loadHarness();
    const bridge = installPgBridge(sql, subFromBearer);
    const restoreLog = captureAccessLog(() => {});
    try {
      const rng = new Rng(SEED ^ 0x05);
      const users = Array.from({ length: 6 }, () => rng.uuidV4());
      for (const u of users) await createUser(sql, u);
      const rows: unknown[] = [];
      const histogram: Record<string, number> = {};
      const violations: string[] = [];
      for (let i = 0; i < ITER; i += 1) {
        const iterSeed = (SEED ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
        const r = new Rng(iterSeed);
        const kind = r.pick<PgKind>([
          "own-open",
          "own-open",
          "own-ended",
          "other-open",
          "missing",
          "malformed-id",
        ]);
        const caller = r.pick(users);
        const other = users[(users.indexOf(caller) + 1 + r.int(users.length - 1)) % users.length];
        let sessionRaw = r.uuidV4();
        let expected: number;
        let expectWrite = 0;
        if (kind === "own-open") {
          await createSession(sql, sessionRaw, caller, null);
          expected = 200;
          expectWrite = 1;
        } else if (kind === "own-ended") {
          await createSession(sql, sessionRaw, caller, new Date(Date.now() - 60_000).toISOString());
          expected = 200;
        } else if (kind === "other-open") {
          await createSession(sql, sessionRaw, other, null);
          expected = 404;
        } else if (kind === "missing") {
          expected = 404;
        } else {
          sessionRaw = r.pick([
            sessionRaw.slice(0, -1),
            sessionRaw.replace(/-/g, ""),
            `${sessionRaw}%00`,
            "%E0%A4%A",
            encodeURIComponent(`${sessionRaw}' or '1'='1`),
            "not-a-uuid",
          ]);
          expected = 400;
        }
        const sumBefore = await checksum(sql, users);
        const callsBefore = bridge.calls.length;
        const res = await h.handler(
          finalizeRequest(sessionRaw, caller, `pg5-${iterSeed.toString(16)}`),
        );
        const body = await res.text();
        const roundCalls = bridge.calls.slice(callsBefore);
        const patches = roundCalls.filter((c) => c.method === "PATCH").length;
        const sumAfter = await checksum(sql, users);
        const outcome = {
          i,
          iterSeed,
          kind,
          caller,
          sessionRaw,
          status: res.status,
          expected,
          patches,
          expectWrite,
          changed: sumAfter !== sumBefore,
          requestId: res.headers.get("x-request-id"),
        };
        rows.push(outcome);
        histogram[`${kind}:${res.status}`] = (histogram[`${kind}:${res.status}`] ?? 0) + 1;
        if (res.status !== expected)
          violations.push(
            `${iterSeed}: ${kind} status ${res.status} != ${expected} (${body.slice(0, 120)})`,
          );
        if (patches !== expectWrite)
          violations.push(`${iterSeed}: ${kind} UPDATE count ${patches} != ${expectWrite}`);
        if ((sumAfter !== sumBefore) !== (expectWrite === 1))
          violations.push(
            `${iterSeed}: ${kind} checksum changed=${sumAfter !== sumBefore} but expected write=${expectWrite}`,
          );
        if (res.headers.get("x-request-id") !== `pg5-${iterSeed.toString(16)}`)
          violations.push(`${iterSeed}: request id not echoed`);
        if (res.status >= 500) violations.push(`${iterSeed}: ${kind} 5xx ${body.slice(0, 200)}`);
      }
      scenarios.PG5 = { iterations: ITER, histogram, violations, rows };
      await flush();
      console.log(
        JSON.stringify({ PG5: { iterations: ITER, histogram, violations: violations.length } }),
      );
      assertEquals(violations, [], "seeded PG campaign violations");
    } finally {
      restoreLog();
      bridge.restore();
      await sql.end();
    }
  },
});
