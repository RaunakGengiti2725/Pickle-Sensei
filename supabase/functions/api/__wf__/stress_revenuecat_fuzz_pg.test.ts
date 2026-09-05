/**
 * STRESS / fuzz-boundary — POST /webhooks/revenuecat against a REAL Postgres.
 *
 * Same production handler as stress_revenuecat_fuzz.test.ts (index.ts, in
 * process through routesHarness), same fake RevenueCat, but the two PostgREST
 * tables the route touches — public.webhook_events and
 * public.billing_entitlements — are served by a disposable postgres:16 with
 * EVERY migration applied (./xc_pg_up.sh), executed as `service_role` with the
 * exact statements PostgREST derives from the supabase-js calls:
 *
 *   select("id").eq("id", x).maybeSingle()            → select id … where id = $1
 *   upsert(row, {onConflict:"id", ignoreDuplicates})  → insert … on conflict (id) do nothing
 *   upsert(row, {onConflict:"user_id"})               → insert … on conflict (user_id) do update set <every payload column>
 *
 * so the persistence oracles below are decided by Postgres itself (uuid
 * collation, jsonb NUL/surrogate rules, btree key limits, the profiles FK,
 * the access_state() gate) rather than by the in-memory model.
 *
 *   ./xc_pg_up.sh                       # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     STRESS_PG_ITER=400 STRESS_SEED=20260905 STRESS_OUT_DIR=/tmp/stress-rc-pg \
 *     deno test -A --no-check --config deno.json stress_revenuecat_fuzz_pg.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d (never a silent pass).
 */

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { loadHarness, WEBHOOK_SECRET } from "./routesHarness.ts";
import {
  BTREE_MAX_INDEX_ROW_BYTES,
  expectedSubjects,
  type FakeBackends,
  generateBody,
  installFakeBackends,
  inspect,
  iterationSeed,
  Prng,
  REQUEST_ID_RE,
} from "./stress_revenuecat_fuzz_lib.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const CAMPAIGN_SEED = Number(Deno.env.get("STRESS_SEED") ?? "20260905") >>> 0;
const ITERATIONS = Math.max(1, Number(Deno.env.get("STRESS_PG_ITER") ?? "60") | 0);
const OUT_DIR = Deno.env.get("STRESS_OUT_DIR") ?? "";
const WEBHOOK_URL = "http://edge.test/functions/v1/api/webhooks/revenuecat";

type Sql = ReturnType<typeof postgres>;

const utf8Len = (s: string | Uint8Array): number =>
  typeof s === "string" ? new TextEncoder().encode(s).byteLength : s.byteLength;

// ─────────────────────────────────────────────────────────────────────────────
// PostgREST → Postgres bridge for the two tables the route writes
// ─────────────────────────────────────────────────────────────────────────────

const COLUMNS: Record<string, readonly string[]> = {
  webhook_events: ["id", "provider", "event_type", "app_user_id", "payload", "received_at"],
  billing_entitlements: ["user_id", "premium", "product_key", "expires_at", "verified_at"],
};

interface PgBridge {
  errors: string[];
  statements: number;
  uninstall(): void;
}

const pgErrorResponse = (code: string, message: string): Response => {
  // PostgREST maps SQLSTATE classes to HTTP statuses; the handler only reads
  // `.error.message`, so the class mapping is all that matters here.
  const status = code === "23503" || code === "23505" ? 409 : code === "42501" ? 403 : 400;
  return new Response(JSON.stringify({ code, message, details: null, hint: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

/** Route the fake's PostgREST traffic for the two audited tables to Postgres.
 * Installed OVER installFakeBackends so RevenueCat keeps using the fake. */
function installPgBridge(sql: Sql, fake: FakeBackends): PgBridge {
  const inner = globalThis.fetch;
  const bridge: PgBridge = {
    errors: [],
    statements: 0,
    uninstall() {
      globalThis.fetch = inner;
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/rest/v1/")) return inner(input, init);
    const table = url.pathname.slice("/rest/v1/".length);
    if (!(table in COLUMNS)) return inner(input, init);
    const c = fake.counters;
    const prefer = request.headers.get("prefer") ?? "";
    const bodyText = await request.text().catch(() => "");
    bridge.statements += 1;

    try {
      if (request.method === "GET") {
        c.lookups += 1;
        const filter = url.searchParams.get("id") ?? "";
        const wanted = filter.startsWith("eq.") ? filter.slice(3) : null;
        const rows = await sql.begin(async (tx) => {
          await tx.unsafe("set local role service_role");
          return await tx.unsafe(`select id from public.${table} where id = $1`, [wanted]);
        });
        return new Response(JSON.stringify(rows.map((r) => ({ id: r.id }))), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (request.method === "POST") {
        c.writes += 1;
        if (table === "webhook_events") c.eventUpserts += 1;
        else c.billingUpserts += 1;
        const conflict = url.searchParams.get("on_conflict");
        const parsed = JSON.parse(bodyText) as Record<string, unknown> | Record<string, unknown>[];
        const first = Array.isArray(parsed) ? parsed[0] : parsed;
        const cols = Object.keys(first).filter((k) => COLUMNS[table].includes(k));
        if (cols.length !== Object.keys(first).length) throw Object.assign(new Error("unknown column"), { code: "42703" });
        const colList = cols.map((k) => `"${k}"`).join(", ");
        const ignoreDup = prefer.includes("resolution=ignore-duplicates");
        const onConflict = conflict
          ? ignoreDup
            ? `on conflict ("${conflict}") do nothing`
            : `on conflict ("${conflict}") do update set ${cols.filter((k) => k !== conflict).map((k) => `"${k}" = excluded."${k}"`).join(", ")}`
          : "";
        await sql.begin(async (tx) => {
          await tx.unsafe("set local role service_role");
          await tx.unsafe(
            `insert into public.${table} (${colList})
               select ${colList} from jsonb_populate_recordset(null::public.${table}, $1::text::jsonb) ${onConflict}`,
            [JSON.stringify(Array.isArray(parsed) ? parsed : [parsed])],
          );
        });
        return new Response(null, { status: 201 });
      }
      throw Object.assign(new Error(`unexpected ${request.method}`), { code: "XX000" });
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "XX000";
      const message = error instanceof Error ? error.message : String(error);
      const tag = `${table === "webhook_events" ? (request.method === "GET" ? "lookup" : "log") : "billing"}:${code}`;
      bridge.errors.push(tag);
      c.pgErrors.push(tag);
      return pgErrorResponse(code, message);
    }
  }) as typeof fetch;

  return bridge;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers (owner role — test setup / oracles only)
// ─────────────────────────────────────────────────────────────────────────────

async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
  const profile = await sql.unsafe(`select 1 from public.profiles where id = '${userId}'`);
  assertEquals(profile.length, 1, "handle_new_user trigger must create the profile");
}

async function billingRow(sql: Sql, userId: string) {
  const r = await sql.unsafe(
    `select user_id::text as user_id, premium, product_key, expires_at::text as expires_at from public.billing_entitlements where user_id = '${userId}'`,
  );
  return r.length ? (r[0] as { user_id: string; premium: boolean; product_key: string | null; expires_at: string | null }) : null;
}

/** Seeded ids repeat across runs against the same disposable DB (repo
 * convention, see xc_pg_rpc_concurrency createUser): drop what an earlier run
 * left behind so each run exercises the first-delivery path. */
async function forgetEvent(sql: Sql, eventId: string): Promise<void> {
  await sql.unsafe(`delete from public.webhook_events where id = $1`, [eventId]);
}

async function auditRows(sql: Sql, eventId: string): Promise<number> {
  const r = await sql.unsafe(`select count(*)::int as n from public.webhook_events where id = $1`, [eventId]);
  return Number(r[0].n);
}

async function accessPremium(sql: Sql, userId: string): Promise<boolean> {
  let premium = false;
  await sql.begin(async (tx) => {
    await tx.unsafe(`set local role authenticated`);
    await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
    const r = await tx.unsafe(`select premium from public.access_state()`);
    premium = Boolean(r[0].premium);
  });
  return premium;
}

const setPremium = (fake: FakeBackends, rcId: string, premium: boolean) => {
  if (premium) fake.rcTruth.set(rcId, { premium: true, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), product: "pickle_sensei_pro_monthly" });
  else fake.rcTruth.delete(rcId);
};

function webhookRequest(raw: string | Uint8Array, ip: string, extra: Record<string, string> = {}): Request {
  const headers: Record<string, string> = {
    authorization: WEBHOOK_SECRET,
    "content-type": "application/json",
    "x-forwarded-for": ip,
    ...extra,
  };
  return new Request(WEBHOOK_URL, { method: "POST", headers, body: raw });
}

const ipFor = (seed: number): string => `10.${(seed >>> 16) & 0xff}.${(seed >>> 8) & 0xff}.${seed & 0xff}`;

interface PgRow {
  i: number;
  seed: number;
  scenario: string;
  body: string;
  eventId: string | null;
  subjects: string[];
  rcPremium: boolean[];
  status: number;
  responseBody: string;
  rcCalls: number;
  writes: number;
  pgErrors: string[];
  auditRows: number;
  billing: Array<{ userId: string; premium: boolean | null; accessPremium: boolean | null }>;
  replayStatus: number | null;
  replayDuplicate: boolean | null;
  replayRcCalls: number | null;
  violations: string[];
  observations: string[];
  ms: number;
}

async function writeJson(name: string, value: unknown): Promise<string | null> {
  if (!OUT_DIR) return null;
  await Deno.mkdir(OUT_DIR, { recursive: true });
  const path = `${OUT_DIR}/${name}`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}

// ─────────────────────────────────────────────────────────────────────────────
// PG-A  seeded event campaign — every accepted event's persistence judged by Postgres
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: `stress/fuzz-boundary PG-A: ${ITERATIONS} seeded events → real webhook_events/billing_entitlements state (seed=${CAMPAIGN_SEED})`,
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    const h = await loadHarness();
    const fake = installFakeBackends();
    const bridge = installPgBridge(sql, fake);
    const rows: PgRow[] = [];
    const idsThisRun = new Set<string>();
    let requests = 0;
    try {
      for (let i = 0; i < ITERATIONS; i++) {
        const seed = iterationSeed(CAMPAIGN_SEED ^ 0x5047, i);
        const prng = new Prng(seed);
        const userId = prng.uuid();
        const hasProfile = prng.chance(0.85);
        if (hasProfile) await createUser(sql, userId);
        const premiumTruth = prng.chance(0.5);
        setPremium(fake, userId, premiumTruth);

        // Only bodies the gate accepts are interesting here — the 400/413
        // paths are exhaustively covered by the in-memory campaign.
        let body = generateBody(prng, userId);
        for (let tries = 0; !body.event && tries < 20; tries++) body = generateBody(prng, userId);
        if (!body.event) continue;
        const event = body.event;
        const subjects = expectedSubjects(event);
        const eventId = typeof event.id === "string" ? event.id : null;
        const row: PgRow = {
          i, seed, scenario: "pg-event", body: `${body.kind}:${body.note}`, eventId: eventId === null ? null : eventId.slice(0, 200),
          subjects: subjects.rcIds, rcPremium: subjects.rcIds.map((id) => Boolean(fake.rcTruth.get(id)?.premium)),
          status: 0, responseBody: "", rcCalls: 0, writes: 0, pgErrors: [], auditRows: 0, billing: [],
          replayStatus: null, replayDuplicate: null, replayRcCalls: null, violations: [], observations: [], ms: 0,
        };
        rows.push(row);
        const v = row.violations;
        const t0 = performance.now();
        if (eventId !== null && !idsThisRun.has(eventId)) await forgetEvent(sql, eventId);
        const preExisting = eventId !== null && (await auditRows(sql, eventId)) > 0;
        if (eventId !== null) idsThisRun.add(eventId);

        fake.resetCounters();
        const res = await inspect(await h.handler(webhookRequest(body.raw, ipFor(seed))));
        requests += 1;
        row.status = res.status;
        row.responseBody = res.text.slice(0, 300);
        row.rcCalls = fake.counters.rcCalls;
        row.writes = fake.counters.writes;
        row.pgErrors = [...fake.counters.pgErrors];
        if (!res.requestId || !REQUEST_ID_RE.test(res.requestId)) v.push(`I1 request id ${res.requestId}`);
        if (res.status !== 200) v.push(`I9 accepted event → ${res.status} ${res.text.slice(0, 120)}`);

        if (preExisting) {
          if (res.json?.duplicate !== true || row.rcCalls > 0 || row.writes > 0) v.push(`I8 pre-existing id not short-circuited (rc=${row.rcCalls} writes=${row.writes})`);
          row.scenario = "pg-event(replayed-id)";
          row.ms = performance.now() - t0;
          continue;
        }

        // Audit row: judged by Postgres. A missing row on a 200 is O1.
        const auditAfter = eventId === null ? -1 : await auditRows(sql, eventId);
        row.auditRows = auditAfter;
        if (eventId !== null && res.status === 200 && auditAfter === 0) {
          row.observations.push(`O1 audit row lost on 200 (${row.pgErrors.filter((e) => e.startsWith("log:")).join(",") || "no pg error"})`);
        }
        if (eventId !== null && auditAfter > 1) v.push(`I8 ${auditAfter} audit rows for one id`);

        // Billing: the stored row must equal RC's verdict for the queried id,
        // for every subject that has a profile (FK) — never the event body.
        // The handler persists subjects in order, so when two case-variants of
        // one uuid are both subjects the LAST verdict is what Postgres keeps.
        const lastRcIdFor = new Map<string, string>();
        for (const rcId of subjects.rcIds) lastRcIdFor.set(rcId.toLowerCase(), rcId);
        for (const [canonical, rcId] of lastRcIdFor) {
          const stored = await billingRow(sql, canonical);
          const expectedPremium = Boolean(fake.rcTruth.get(rcId)?.premium);
          const profileExists = (await sql.unsafe(`select 1 from public.profiles where id = '${canonical}'`)).length === 1;
          row.billing.push({ userId: canonical, premium: stored?.premium ?? null, accessPremium: profileExists ? await accessPremium(sql, canonical) : null });
          if (res.status !== 200) continue;
          if (!profileExists) {
            if (stored) v.push(`I7 billing row for user without profile ${canonical}`);
            continue;
          }
          if (!stored) v.push(`I7 no billing row for ${canonical}`);
          else if (stored.premium !== expectedPremium) v.push(`I7 ${canonical} stored premium=${stored.premium} but RC(${rcId})=${expectedPremium}`);
          if (!expectedPremium && stored?.premium) v.push(`I7 premium stored for ${canonical} although RevenueCat says free (event claims: premium=${String(event.premium)} entitlement_ids=${JSON.stringify(event.entitlement_ids)})`);
          if (rcId !== canonical) row.observations.push(`O2 case-variant subject ${rcId} → row ${canonical} premium=${stored?.premium} (RC truth for ${canonical}: ${Boolean(fake.rcTruth.get(canonical)?.premium)})`);
        }

        // Replay: with the audit row present Postgres must make the second
        // delivery a no-op; without it the handler re-verifies (O1 consequence).
        if (eventId !== null && res.status === 200) {
          fake.resetCounters();
          const replay = await inspect(await h.handler(webhookRequest(body.raw, ipFor(seed))));
          requests += 1;
          row.replayStatus = replay.status;
          row.replayDuplicate = replay.json?.duplicate === true;
          row.replayRcCalls = fake.counters.rcCalls;
          if (auditAfter > 0) {
            if (replay.status !== 200 || replay.json?.duplicate !== true) v.push(`I8 replay → ${replay.status} ${replay.text.slice(0, 100)}`);
            if (fake.counters.rcCalls + fake.counters.writes > 0) v.push(`I8 replay did work (rc=${fake.counters.rcCalls} writes=${fake.counters.writes})`);
            if ((await auditRows(sql, eventId)) !== 1) v.push(`I8 audit rows after replay ≠ 1`);
          } else if (replay.json?.duplicate === true) {
            v.push(`I8 replay reported duplicate without an audit row`);
          }
        }
        row.ms = performance.now() - t0;
      }
    } finally {
      bridge.uninstall();
      fake.uninstall();
      await sql.end();
    }

    const violating = rows.filter((r) => r.violations.length);
    const summary = {
      seed: CAMPAIGN_SEED,
      iterations: rows.length,
      requests,
      violations: violating.length,
      statusHistogram: rows.reduce<Record<string, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {}),
      pgErrorHistogram: rows.flatMap((r) => r.pgErrors).reduce<Record<string, number>>((acc, e) => ((acc[e] = (acc[e] ?? 0) + 1), acc), {}),
      observationHistogram: rows.flatMap((r) => r.observations.map((o) => o.slice(0, 2))).reduce<Record<string, number>>((acc, o) => ((acc[o] = (acc[o] ?? 0) + 1), acc), {}),
      bridgeStatements: bridge.statements,
      violating: violating.map((r) => ({ seed: r.seed, violations: r.violations, body: r.body, eventId: r.eventId })),
      replay: `STRESS_PG_ITER=${ITERATIONS} STRESS_SEED=${CAMPAIGN_SEED} XC_PG_URL=… deno test -A --no-check --config deno.json stress_revenuecat_fuzz_pg.test.ts`,
    };
    const out = await writeJson("stress_revenuecat_fuzz_pg.summary.json", summary);
    await writeJson("stress_revenuecat_fuzz_pg.rows.json", rows);
    console.log(`[stress-pg] PG-A: iterations=${rows.length} requests=${requests} violations=${violating.length} pgErrors=${JSON.stringify(summary.pgErrorHistogram)} observations=${JSON.stringify(summary.observationHistogram)}${out ? ` → ${out}` : ""}`);
    for (const r of violating) console.log(`[stress-pg]   seed ${r.seed}: ${r.violations.join(" | ")}`);
    assertEquals(violating.length, 0, `hard invariant violations at seeds ${violating.map((r) => r.seed).join(", ")}`);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PG-B  concurrent duplicate delivery — the PK is the only serialization point
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress/fuzz-boundary PG-B: 8 simultaneous deliveries of one event → exactly one audit row, billing = RC verdict, later replay is a no-op",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(PG_URL, { max: 10, onnotice: () => {} });
    const h = await loadHarness();
    const fake = installFakeBackends();
    const bridge = installPgBridge(sql, fake);
    try {
      const prng = new Prng(iterationSeed(CAMPAIGN_SEED, 0x8000));
      const userId = prng.uuid();
      await createUser(sql, userId);
      setPremium(fake, userId, true);
      const eventId = `pgb-${prng.hex(24)}`;
      await forgetEvent(sql, eventId);
      const raw = JSON.stringify({ api_version: "1.0", event: { id: eventId, type: "RENEWAL", app_user_id: userId, aliases: [userId] } });

      fake.resetCounters();
      const statuses = await Promise.all(Array.from({ length: 8 }, (_, k) => h.handler(webhookRequest(raw, `10.9.9.${k}`)).then(inspect)));
      const results = statuses.map((r) => ({ status: r.status, duplicate: r.json?.duplicate === true, verified: r.json?.verified }));
      console.log(`[stress-pg] PG-B: statuses=${JSON.stringify(results)} rc=${fake.counters.rcCalls} writes=${fake.counters.writes} pgErrors=${fake.counters.pgErrors.join(",") || "none"}`);
      for (const r of results) assertEquals(r.status, 200);
      assertEquals(await auditRows(sql, eventId), 1, "exactly one audit row");
      assertEquals(fake.counters.pgErrors.filter((e) => !e.startsWith("log:23505")).length, 0, "only a PK race may surface");
      const stored = await billingRow(sql, userId);
      assert(stored?.premium === true, "billing row equals RC verdict (premium)");
      assertEquals(await accessPremium(sql, userId), true);

      // Concurrent copies all raced past the lookup → each re-verified (no row yet).
      // Not a correctness failure (the verdict is idempotent) but recorded.
      const rcCallsDuringRace = fake.counters.rcCalls;
      fake.resetCounters();
      const replay = await inspect(await h.handler(webhookRequest(raw, "10.9.9.99")));
      assertEquals(replay.status, 200);
      assertEquals(replay.json?.duplicate, true);
      assertEquals(fake.counters.rcCalls, 0);
      assertEquals(fake.counters.writes, 0);
      await writeJson("stress_revenuecat_fuzz_pg_B.json", { eventId, results, rcCallsDuringRace, auditRows: 1, replay: replay.json, bridgeStatements: bridge.statements });
    } finally {
      bridge.uninstall();
      fake.uninstall();
      await sql.end();
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PG-C  REPRO (defect): upper-cased uuid alias revokes a premium user's row
//       through Postgres' case-insensitive uuid key, and access_state() follows
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress/fuzz-boundary PG-C REPRO (defect): EXPIRATION for UPPER-CASED app_user_id overwrites the lower-case user's premium row (uuid pk is case-insensitive) → access_state() premium=false",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    const h = await loadHarness();
    const fake = installFakeBackends();
    const bridge = installPgBridge(sql, fake);
    try {
      const prng = new Prng(iterationSeed(CAMPAIGN_SEED, 0x8001));
      const userId = prng.uuid();
      await createUser(sql, userId);
      setPremium(fake, userId, true); // RevenueCat truth for the CANONICAL id: premium
      const id1 = `pgc1-${prng.hex(16)}`;
      const id2 = `pgc2-${prng.hex(16)}`;
      await forgetEvent(sql, id1);
      await forgetEvent(sql, id2);
      const first = await inspect(await h.handler(webhookRequest(JSON.stringify({ event: { id: id1, type: "INITIAL_PURCHASE", app_user_id: userId } }), "10.8.8.1")));
      assertEquals(first.status, 200);
      assertEquals((await billingRow(sql, userId))?.premium, true);
      assertEquals(await accessPremium(sql, userId), true);

      // Same uuid, upper-cased: RevenueCat has no such subscriber (auto-created
      // free); Postgres treats it as the SAME user_id.
      const upper = userId.toUpperCase();
      fake.resetCounters();
      const second = await inspect(await h.handler(webhookRequest(JSON.stringify({ event: { id: id2, type: "EXPIRATION", app_user_id: upper } }), "10.8.8.2")));
      assertEquals(second.status, 200);
      assertEquals(fake.counters.rcIds, [upper], "handler queried RevenueCat with the upper-cased id verbatim");
      const stored = await billingRow(sql, userId);
      const access = await accessPremium(sql, userId);
      console.log(`[stress-pg] PG-C: after EXPIRATION(${upper}) → billing_entitlements(${userId}).premium=${stored?.premium} access_state().premium=${access}`);
      await writeJson("stress_revenuecat_fuzz_pg_C.json", { userId, upper, rcTruthCanonical: "premium", rcQueried: fake.counters.rcIds, stored, accessPremium: access });
      // Defect pinned: the premium user's server-verified access is revoked by a
      // verdict for a different RevenueCat subscriber id.
      assertEquals(stored?.user_id, userId);
      assertEquals(stored?.premium, false);
      assertEquals(access, false);
    } finally {
      bridge.uninstall();
      fake.uninstall();
      await sql.end();
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PG-D  REPRO (defect): payloads Postgres refuses → 200 with no audit row,
//       so the same event id is fully re-processed on every redelivery
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress/fuzz-boundary PG-D REPRO (defect): NUL in payload (22P05) / >2704-byte event id (54000) → 200, no webhook_events row, replay re-verifies instead of short-circuiting",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    const h = await loadHarness();
    const fake = installFakeBackends();
    const bridge = installPgBridge(sql, fake);
    try {
      const prng = new Prng(iterationSeed(CAMPAIGN_SEED, 0x8002));
      const userId = prng.uuid();
      await createUser(sql, userId);
      setPremium(fake, userId, true);
      const cases = [
        { name: "nul-in-subscriber-attribute", id: `pgd-nul-${prng.hex(16)}`, event: { type: "RENEWAL", app_user_id: userId, subscriber_attributes: { note: { value: "a\u0000b" } } }, expectCode: "log:22P05" },
        { name: "event-id-3000-hex-bytes", id: prng.hex(BTREE_MAX_INDEX_ROW_BYTES + 296), event: { type: "RENEWAL", app_user_id: userId }, expectCode: "log:54000" },
      ];
      const results: unknown[] = [];
      for (const c of cases) {
        await forgetEvent(sql, c.id);
        const raw = JSON.stringify({ event: { id: c.id, ...c.event } });
        fake.resetCounters();
        const first = await inspect(await h.handler(webhookRequest(raw, "10.7.7.1")));
        const firstErrors = [...fake.counters.pgErrors];
        const audit = await auditRows(sql, c.id);
        fake.resetCounters();
        const replay = await inspect(await h.handler(webhookRequest(raw, "10.7.7.2")));
        const r = { case: c.name, idBytes: utf8Len(c.id), first: { status: first.status, body: first.json, pgErrors: firstErrors }, auditRows: audit, replay: { status: replay.status, body: replay.json, rcCalls: fake.counters.rcCalls, pgErrors: [...fake.counters.pgErrors] } };
        results.push(r);
        console.log(`[stress-pg] PG-D ${c.name}: ${JSON.stringify(r)}`);
        assertEquals(first.status, 200, "handler acknowledges");
        assert(firstErrors.includes(c.expectCode), `Postgres refused the audit row with ${c.expectCode}: ${firstErrors.join(",")}`);
        assertEquals(audit, 0, "no audit row");
        assertEquals(replay.status, 200);
        assertEquals(replay.json?.duplicate, undefined, "replay is NOT detected as duplicate");
        assertEquals(fake.counters.rcCalls, 1, "replay re-verifies against RevenueCat");
      }
      // Billing state itself is unaffected (verdict came from RC, not the payload).
      assertEquals((await billingRow(sql, userId))?.premium, true);
      await writeJson("stress_revenuecat_fuzz_pg_D.json", results);
    } finally {
      bridge.uninstall();
      fake.uninstall();
      await sql.end();
    }
  },
});
