/**
 * Stress: `GET /v1/me/consent/status` against a REAL Postgres (docker
 * postgres:16 + shim_auth.sql + every migration), the route's own PostgREST
 * query translated to SQL and executed under `role authenticated` with the
 * bearer's `sub` — i.e. through the real `consent_records` schema, RLS policy,
 * grants and ordering, not the modelled table in the harness.
 *
 * The route has no RPC (it reads consent_records through PostgREST), so this
 * is the Postgres-backed leg the failure-load lens asks for: the same
 * in-process handler, the same fault queue in front of the DB, but the rows
 * come back from Postgres.
 *
 *   ./xc_pg_up.sh                      # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json stress_consent_status_pg.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d.
 * STRESS_PG_USERS (default 60; full campaign 300) users are seeded.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  assertInvariants,
  countBy,
  type Invariant,
  jwtPayload,
  type LedgerRow,
  loadStressHarness,
  oracleFold,
  Prng,
  requestFor,
  seededLedger,
  seededUser,
  STRESS_SEED,
  type StressHarness,
  type StressUser,
  writeJson,
} from "./stress_consent_status_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const STRESS_PG_USERS = Number.parseInt(Deno.env.get("STRESS_PG_USERS") ?? "60", 10);
const FILE = "stress_consent_status_pg.test.ts";

type Sql = ReturnType<typeof postgres>;

/** The exact query the route issues (index.ts loadConsentRows). */
const ROUTE_SELECT = "scope, action, consent_version, created_at";
const ROUTE_ORDER = "created_at.asc,id.asc";

interface PgCallRecord {
  sub: string | null;
  filterUserId: string | null;
  select: string;
  order: string;
  rows: number;
  status: number;
  sqlstate?: string;
}

/** PostgREST renders timestamptz as `2026-01-01T00:00:00.123456+00:00`. */
function postgrestTimestamp(value: Date): string {
  const iso = value.toISOString();
  return `${iso.slice(0, -1)}+00:00`;
}

/** Translate the captured PostgREST GET into SQL under the bearer's identity. */
function pgBackend(sql: Sql, log: PgCallRecord[], hooks: { beforeQuery?: string }) {
  return async (request: Request, parsed: URL): Promise<Response> => {
    const table = parsed.pathname.slice("/rest/v1/".length);
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const sub = (jwtPayload(token)?.sub as string | undefined) ?? null;
    const select = parsed.searchParams.get("select") ?? "*";
    const order = parsed.searchParams.get("order") ?? "";
    const eq = parsed.searchParams.get("user_id") ?? "";
    const filterUserId = eq.startsWith("eq.") ? eq.slice(3) : null;
    const record: PgCallRecord = { sub, filterUserId, select, order, rows: 0, status: 0 };
    log.push(record);
    if (request.method !== "GET" || table !== "consent_records") {
      record.status = 404;
      return new Response(
        JSON.stringify({ code: "PGRST205", message: `Could not find the table 'public.${table}'` }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    if (select !== ROUTE_SELECT.replace(/ /g, "") && select !== ROUTE_SELECT) {
      record.status = 400;
      return new Response(
        JSON.stringify({ code: "PGRST100", message: `unexpected select ${select}` }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    if (order !== ROUTE_ORDER) {
      record.status = 400;
      return new Response(
        JSON.stringify({ code: "PGRST100", message: `unexpected order ${order}` }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    if (!/^[0-9a-f-]{36}$/i.test(filterUserId ?? "") || !/^[0-9a-f-]{36}$/i.test(sub ?? "")) {
      record.status = 400;
      return new Response(
        JSON.stringify({ code: "22P02", message: "invalid input syntax for type uuid" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    try {
      const rows = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role authenticated`);
        await tx.unsafe(`set local request.jwt.claim.sub = '${sub}'`);
        if (hooks.beforeQuery) await tx.unsafe(hooks.beforeQuery);
        return await tx.unsafe(
          `select scope, action, consent_version, created_at
             from public.consent_records
            where user_id = '${filterUserId}'
            order by created_at asc, id asc`,
        );
      });
      const body = (
        rows as unknown as Array<{
          scope: string;
          action: string;
          consent_version: string | null;
          created_at: Date;
        }>
      ).map((r) => ({
        scope: r.scope,
        action: r.action,
        consent_version: r.consent_version,
        created_at: postgrestTimestamp(r.created_at),
      }));
      record.rows = body.length;
      record.status = 200;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-range": `0-${Math.max(0, body.length - 1)}/*`,
        },
      });
    } catch (error) {
      const e = error as { code?: string; message?: string };
      record.sqlstate = e.code;
      // PostgREST: 42501 → 403, 42P01 → 404, 22xxx → 400, everything else 500.
      const status =
        e.code === "42501" ? 403 : e.code === "42P01" ? 404 : e.code?.startsWith("22") ? 400 : 500;
      record.status = status;
      return new Response(
        JSON.stringify({
          code: e.code ?? "PGRST000",
          message: e.message ?? "db error",
          details: null,
          hint: null,
        }),
        { status, headers: { "content-type": "application/json" } },
      );
    }
  };
}

async function seedUser(sql: Sql, user: StressUser, ledger: LedgerRow[]): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${user.id}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${user.id}', '${user.email.replace(/'/g, "")}', '{"provider":"${user.provider}"}')`,
  );
  for (const row of ledger) {
    await sql`insert into public.consent_records (id, user_id, scope, consent_version, action, source, created_at)
      values (${row.id}, ${row.user_id}, ${row.scope}, ${row.consent_version}, ${row.action}, ${"stress"}, ${row.created_at})`;
  }
}

/** lastActionAt comes back in PostgREST's `+00:00` form; compare instants. */
function normalizeBody(body: unknown): unknown {
  const b = body as {
    subjectPseudonym: null;
    scopes: Array<{ lastActionAt: string | null } & Record<string, unknown>>;
  };
  return {
    ...b,
    scopes: b.scopes.map((s) => ({
      ...s,
      lastActionAt: s.lastActionAt === null ? null : new Date(s.lastActionAt).toISOString(),
    })),
  };
}

Deno.test({
  name: `stress consent-status: real Postgres — ${STRESS_PG_USERS} seeded ledgers through the route (schema, RLS, ordering) + faults in front of the DB`,
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    const h: StressHarness = await loadStressHarness();
    const pgLog: PgCallRecord[] = [];
    const hooks: { beforeQuery?: string } = {};
    h.reset();
    h.postgrestBackend = pgBackend(sql, pgLog, hooks);
    const prng = new Prng((STRESS_SEED ^ 0x9d) >>> 0);
    const invariants: Invariant[] = [];
    const outcomes: Array<Record<string, unknown>> = [];
    try {
      // ── seed ────────────────────────────────────────────────────────────
      const users: StressUser[] = [];
      const ledgers = new Map<string, LedgerRow[]>();
      for (let i = 0; i < STRESS_PG_USERS; i += 1) {
        const user = seededUser(prng, 50_000 + i);
        const ledger = seededLedger(prng, user.id);
        users.push(user);
        ledgers.set(user.id, ledger);
        h.addUser(user, []); // Auth knows the user; rows live only in Postgres.
        await seedUser(sql, user, ledger);
      }
      const seededRows = [...ledgers.values()].reduce((n, l) => n + l.length, 0);

      // ── 1. every user's fold matches the oracle, 2 round trips cold, 1 warm ──
      let mismatched = 0;
      let cold2 = 0;
      let warm1 = 0;
      for (const user of users) {
        const cold = await h.request(requestFor(user));
        const coldBody = await cold.response.json();
        const want = JSON.stringify(normalizeBody(oracleFold(ledgers.get(user.id)!)));
        const gotCold = JSON.stringify(normalizeBody(coldBody));
        if (countBy(cold.calls, "auth") === 1 && countBy(cold.calls, "postgrest") === 1) cold2 += 1;
        const warm = await h.request(requestFor(user));
        const gotWarm = JSON.stringify(normalizeBody(await warm.response.json()));
        if (countBy(warm.calls, "auth") === 0 && countBy(warm.calls, "postgrest") === 1) warm1 += 1;
        const ok =
          cold.response.status === 200 &&
          warm.response.status === 200 &&
          gotCold === want &&
          gotWarm === want;
        if (!ok) mismatched += 1;
        outcomes.push({
          user: user.id,
          rows: ledgers.get(user.id)!.length,
          coldStatus: cold.response.status,
          warmStatus: warm.response.status,
          ok,
          ...(ok ? {} : { want, gotCold, gotWarm }),
        });
      }
      invariants.push({
        name: `every seeded user's status equals the oracle fold of its Postgres ledger (${STRESS_PG_USERS} users, ${seededRows} rows, cold + warm)`,
        holds: mismatched === 0,
        detail: `${mismatched} mismatched`,
      });
      invariants.push({
        name: "cold request = 1 Auth + 1 PostgREST round trip",
        holds: cold2 === users.length,
        detail: `${cold2}/${users.length}`,
      });
      invariants.push({
        name: "warm request = 0 Auth + 1 PostgREST round trip",
        holds: warm1 === users.length,
        detail: `${warm1}/${users.length}`,
      });

      // ── 2. RLS: the DB, not the filter, scopes rows to the bearer ────────
      const [a, b] = users;
      const richA = users.find((u) => (ledgers.get(u.id)?.length ?? 0) > 0) ?? a;
      const other = users.find((u) => u.id !== richA.id) ?? b;
      const asOtherForA = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role authenticated`);
        await tx.unsafe(`set local request.jwt.claim.sub = '${other.id}'`);
        return await tx.unsafe(
          `select count(*)::int as n from public.consent_records where user_id = '${richA.id}'`,
        );
      });
      const asOwner = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role authenticated`);
        await tx.unsafe(`set local request.jwt.claim.sub = '${richA.id}'`);
        return await tx.unsafe(
          `select count(*)::int as n from public.consent_records where user_id = '${richA.id}'`,
        );
      });
      const crossRows = (asOtherForA as unknown as Array<{ n: number }>)[0].n;
      const ownRows = (asOwner as unknown as Array<{ n: number }>)[0].n;
      invariants.push({
        name: "RLS: another authenticated user selecting the owner's ledger sees 0 rows; the owner sees all",
        holds: crossRows === 0 && ownRows === (ledgers.get(richA.id)?.length ?? 0),
        detail: `cross=${crossRows} own=${ownRows}`,
      });
      let appendOnly = "not attempted";
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`set local role authenticated`);
          await tx.unsafe(`set local request.jwt.claim.sub = '${richA.id}'`);
          await tx.unsafe(`delete from public.consent_records where user_id = '${richA.id}'`);
        });
        appendOnly = "delete succeeded";
      } catch (error) {
        appendOnly = `refused ${(error as { code?: string }).code}`;
      }
      invariants.push({
        name: "append-only: the owner cannot DELETE consent rows (42501)",
        holds: appendOnly === "refused 42501",
        detail: appendOnly,
      });

      // ── 3. faults in front of the real DB ────────────────────────────────
      h.inject({ upstream: "postgrest", spec: { kind: "network", message: "reset" } });
      const retried = await h.request(requestFor(richA));
      const retriedBody = JSON.stringify(normalizeBody(await retried.response.json()));
      invariants.push({
        name: "socket reset once in front of Postgres → library retry, 200, body = oracle, 2 DB round trips",
        holds:
          retried.response.status === 200 &&
          retriedBody === JSON.stringify(normalizeBody(oracleFold(ledgers.get(richA.id)!))) &&
          countBy(retried.calls, "postgrest") === 2,
        detail: `${retried.response.status} postgrest=${countBy(retried.calls, "postgrest")} ${retried.latencyMs.toFixed(0)}ms`,
      });
      h.inject({
        upstream: "postgrest",
        spec: { kind: "http", status: 500, json: { code: "XX000", message: "SECRET-pg-detail" } },
      });
      const failed = await h.request(requestFor(richA));
      const failedText = await failed.response.text();
      invariants.push({
        name: "PostgREST 500 in front of Postgres → 503 generic, no DB detail in the body",
        holds:
          failed.response.status === 503 &&
          !failedText.includes("SECRET-pg-detail") &&
          failedText.includes("temporarily unavailable"),
        detail: `${failed.response.status} ${failedText.slice(0, 120)}`,
      });

      // ── 4. a real Postgres error (statement_timeout) surfaces as a generic 503 ──
      hooks.beforeQuery = `set local statement_timeout = '1ms'; select pg_sleep(0.05)`;
      const timedOut = await h.request(requestFor(richA));
      const timedOutText = await timedOut.response.text();
      hooks.beforeQuery = undefined;
      const last = pgLog[pgLog.length - 1];
      invariants.push({
        name: "statement_timeout (57014) in Postgres → PostgREST-shaped 500 → route 503 generic, sqlstate only in server log",
        holds:
          last.sqlstate === "57014" &&
          timedOut.response.status === 503 &&
          !timedOutText.includes("57014") &&
          !timedOutText.includes("statement timeout"),
        detail: `sqlstate=${last.sqlstate} status=${timedOut.response.status} body=${timedOutText.slice(0, 100)}`,
      });
      const recovered = await h.request(requestFor(richA));
      invariants.push({
        name: "next request after the DB error recovers (200)",
        holds: recovered.response.status === 200,
        detail: String(recovered.response.status),
      });
      await recovered.response.body?.cancel();

      const path = await writeJson("pg_backed", {
        seed: STRESS_SEED,
        users: STRESS_PG_USERS,
        seededRows,
        pgCalls: pgLog.length,
        pgStatusHistogram: pgLog.reduce<Record<string, number>>(
          (acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc),
          {},
        ),
        invariants,
        outcomes,
        replay: `XC_PG_URL=<from ./xc_pg_up.sh> STRESS_SEED=${STRESS_SEED} STRESS_PG_USERS=${STRESS_PG_USERS} deno test -A --no-check --config deno.json ${FILE}`,
      });
      console.log(
        `[stress] pg-backed: ${STRESS_PG_USERS} users / ${seededRows} rows, ${pgLog.length} PG calls, mismatched=${mismatched} → ${path}`,
      );
      assert(outcomes.length === STRESS_PG_USERS);
      assertEquals(mismatched, 0, "route fold ≠ oracle on real Postgres");
      assertInvariants(invariants, "pg-backed");
    } finally {
      h.postgrestBackend = null;
      h.clearFaults();
      await sql.end({ timeout: 5 });
    }
  },
});
