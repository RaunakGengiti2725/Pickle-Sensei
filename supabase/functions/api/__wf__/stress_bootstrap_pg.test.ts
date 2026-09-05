/**
 * stress-route-post-v1-account-bootstrap — CONCURRENCY lens, REAL Postgres.
 *
 * Same REAL edge handler (../index.ts) as stress_bootstrap_concurrency.test.ts,
 * but every PostgREST call the route makes (profiles read/PATCH,
 * account_external_credentials upsert, access_state() RPC) is translated to
 * SQL and executed on a disposable postgres:16 with shim_auth.sql + EVERY
 * migration applied (./xc_pg_up.sh), in its own transaction, as the same
 * role PostgREST would use (`authenticated` + request.jwt.claim.sub, or
 * `service_role`). GoTrue's signInWithIdToken is modelled as what it does to
 * the database — INSERT auth.users + auth.identities (auto-link by verified
 * email) — so the real triggers fire: handle_new_user() (profiles row),
 * inherit_free_rating_ledger() (late-linked identity ledger). Sessions,
 * getUser, refresh, logout stay on the FakeSupabase auth model; Apple's
 * token endpoint is the same fake as the in-process file.
 *
 *   ./xc_pg_up.sh                               # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json stress_bootstrap_pg.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 *
 * Scenarios (STRESS_ITER rounds × STRESS_LANES lanes, seeded):
 *   P1 dup-signup-burst     N concurrent first sign-ins of one identity
 *   P2 provider-flip        Google/Apple flips on one account, jittered
 *   P3 two-actors           two accounts × two devices, provider flips
 *   P4 cancel-then-retry    client aborts mid-flight, retries
 *   P5 late-link-ledger     Apple identity auto-linked to a Google account
 *                           that already spent its free ratings, while both
 *                           providers bootstrap concurrently
 */
import postgres from "postgres";
import { assertEquals } from "@std/assert";
import { decryptAppleRefreshToken } from "../externalAccounts.ts";
import { loadXcHarness } from "./xc_concurrency_harness.ts";
import {
  appleCode,
  type AppleEndpointStats,
  appleTokenResponse,
  bootstrapRequest,
  edgeGet,
  fnv1a,
  installAppleServerEnv,
  inv,
  type Invariant,
  isRecord,
  jittered,
  jwtPayload,
  type LaneRow,
  printRound,
  Prng,
  providerIdToken,
  readJson,
  resetFake,
  type RoundReport,
  roundSeed,
  roundsToRun,
  sessionOf,
  sleep,
  STRESS_LANES,
  STRESS_LATENCY,
  STRESS_SEED,
  summarize,
  timed,
  withDeadline,
  writeRounds,
  type XcHarness,
} from "./stress_bootstrap_harness.ts";

const FILE = "stress_bootstrap_pg.test.ts";
const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (name: string): string => {
  if (!IDENT.test(name)) throw new Error(`bridge: refusing identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
};

/** Deterministic uuid for a brand-new (provider, subject) — what GoTrue's
 * gen_random_uuid() would be, made replayable. */
async function uuidFor(provider: string, sub: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${provider}:${sub}`)),
  );
  const hex = Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// ── PostgREST → SQL bridge ───────────────────────────────────────────────────

interface Bridge {
  /** pool of the scenario currently running (opened/closed per Deno.test) */
  sql: Sql | null;
  apple: AppleEndpointStats;
  /** every PG error the bridge translated (SQLSTATE → count) */
  pgErrors: Record<string, number>;
  /** profiles PATCHes in COMMIT order (last = last write) */
  providerPatches: Array<{ userId: string; provider: string }>;
  signups: number;
}

let loaded: { h: XcHarness; bridge: Bridge } | null = null;

function pgErrorResponse(bridge: Bridge, error: unknown): Response {
  const e = error as { code?: string; message?: string; detail?: string; hint?: string };
  const code = e.code ?? "XX000";
  bridge.pgErrors[code] = (bridge.pgErrors[code] ?? 0) + 1;
  const status = code === "42501" ? 403 : code === "23505" ? 409 : 400;
  return new Response(
    JSON.stringify({
      code,
      message: e.message ?? String(error),
      details: e.detail ?? null,
      hint: e.hint ?? null,
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

async function actAs(tx: Tx, who: { role: "service" | "user" | "anon"; userId: string | null }) {
  if (who.role === "service") {
    await tx.unsafe(`set local role service_role`);
    return;
  }
  if (who.role === "user" && who.userId) {
    await tx.unsafe(`set local role authenticated`);
    await tx`select set_config('request.jwt.claim.sub', ${who.userId}, true)`;
    return;
  }
  await tx.unsafe(`set local role anon`);
}

function whereClause(params: URLSearchParams): { text: string; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];
  for (const [key, raw] of params) {
    if (["select", "on_conflict", "order", "limit", "offset", "columns"].includes(key)) continue;
    const dot = raw.indexOf(".");
    const op = dot === -1 ? "eq" : raw.slice(0, dot);
    const value = dot === -1 ? raw : raw.slice(dot + 1);
    if (op !== "eq") throw new Error(`bridge: unsupported filter ${key}=${raw}`);
    values.push(value);
    parts.push(`${ident(key)} = $${values.length}`);
  }
  return { text: parts.length ? ` where ${parts.join(" and ")}` : "", values };
}

function selectList(params: URLSearchParams): string {
  const select = params.get("select") ?? "*";
  if (select.trim() === "*") return "*";
  return select
    .split(",")
    .map((c) => ident(c.trim()))
    .join(", ");
}

async function restBridge(
  h: XcHarness,
  bridge: Bridge,
  request: Request,
  rawBody: string,
): Promise<Response> {
  const url = new URL(request.url);
  const target = url.pathname.slice("/rest/v1/".length);
  const who = h.fake.principal(request.headers);
  const json = (status: number, body: unknown) =>
    new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  if (STRESS_LATENCY > 0) await sleep(h.fake.prng.int(0, STRESS_LATENCY));
  const body = rawBody ? (JSON.parse(rawBody) as unknown) : {};
  try {
    return await pool(bridge).begin(async (tx) => {
      await actAs(tx, who);
      if (target.startsWith("rpc/")) {
        const fn = target.slice(4);
        h.fake.count(`pg.rpc.${fn}`);
        if (!isRecord(body) || Object.keys(body).length > 0) {
          throw new Error(`bridge: rpc ${fn} with arguments not supported`);
        }
        const rows = await tx.unsafe(`select * from public.${ident(fn)}()`);
        return json(200, rows);
      }
      const table = `public.${ident(target)}`;
      h.fake.count(`pg.${request.method.toLowerCase()}.${target}`);
      const prefer = request.headers.get("prefer") ?? "";
      const representation = prefer.includes("return=representation");
      if (request.method === "GET") {
        const w = whereClause(url.searchParams);
        const rows = await tx.unsafe(
          `select ${selectList(url.searchParams)} from ${table}${w.text}`,
          w.values as never[],
        );
        const accept = request.headers.get("accept") ?? "";
        if (accept.includes("application/vnd.pgrst.object+json")) {
          if (rows.length !== 1) {
            return json(406, {
              code: "PGRST116",
              message: "JSON object requested, multiple (or no) rows returned",
              details: `The result contains ${rows.length} rows`,
              hint: null,
            });
          }
          return json(200, rows[0]);
        }
        return json(200, rows);
      }
      if (request.method === "PATCH") {
        if (!isRecord(body)) throw new Error("bridge: PATCH body must be an object");
        const w = whereClause(url.searchParams);
        const values = [...w.values];
        const sets = Object.entries(body).map(([k, v]) => {
          values.push(v as never);
          return `${ident(k)} = $${values.length}`;
        });
        const rows = await tx.unsafe(
          `update ${table} set ${sets.join(", ")}${w.text} returning *`,
          values as never[],
        );
        if (target === "profiles" && typeof body.provider === "string") {
          const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
          bridge.providerPatches.push({ userId: id, provider: body.provider });
        }
        return representation ? json(200, rows) : json(204, null);
      }
      if (request.method === "POST") {
        const incoming = Array.isArray(body)
          ? (body as Array<Record<string, unknown>>)
          : [body as Record<string, unknown>];
        const conflict = url.searchParams.get("on_conflict");
        const out: unknown[] = [];
        for (const row of incoming) {
          const cols = Object.keys(row);
          const values = cols.map((c) => row[c]);
          const placeholders = cols.map((_, i) => `$${i + 1}`);
          let stmt = `insert into ${table} (${cols.map(ident).join(", ")}) values (${placeholders.join(", ")})`;
          if (conflict) {
            if (prefer.includes("resolution=ignore-duplicates")) {
              stmt += ` on conflict (${ident(conflict)}) do nothing`;
            } else if (prefer.includes("resolution=merge-duplicates")) {
              stmt += ` on conflict (${ident(conflict)}) do update set ${cols
                .filter((c) => c !== conflict)
                .map((c) => `${ident(c)} = excluded.${ident(c)}`)
                .join(", ")}`;
            }
          }
          stmt += " returning *";
          const rows = await tx.unsafe(stmt, values as never[]);
          out.push(...rows);
        }
        return representation ? json(201, out) : json(201, null);
      }
      if (request.method === "DELETE") {
        const w = whereClause(url.searchParams);
        const rows = await tx.unsafe(
          `delete from ${table}${w.text} returning *`,
          w.values as never[],
        );
        return representation ? json(200, rows) : json(204, null);
      }
      throw new Error(`bridge: unsupported method ${request.method}`);
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("bridge:")) {
      h.fake.log("bridge.error", error.message);
      return new Response(error.message, { status: 599 });
    }
    return pgErrorResponse(bridge, error);
  }
}

/** GoTrue signInWithIdToken as a database effect: find the identity, else
 * auto-link to an existing user with the same verified email (GoTrue's
 * default for trusted providers), else create the user. All in one
 * transaction with the same ON CONFLICT DO NOTHING GoTrue relies on, so N
 * concurrent first sign-ins of one identity converge on one auth.users row
 * (and therefore one profiles row through handle_new_user()). */
async function signupBridge(h: XcHarness, bridge: Bridge, rawBody: string): Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  h.fake.count("gotrue.token.id_token");
  if (STRESS_LATENCY > 0) await sleep(h.fake.prng.int(0, STRESS_LATENCY));
  const body = JSON.parse(rawBody) as Record<string, unknown>;
  const idToken = typeof body.id_token === "string" ? body.id_token : "";
  const payload = jwtPayload(idToken);
  const sub = typeof payload?.sub === "string" ? payload.sub : "";
  const iss = typeof payload?.iss === "string" ? payload.iss : "";
  const provider = iss.includes("apple") ? "apple" : "google";
  const email = typeof payload?.email === "string" ? payload.email : `${sub}@example.com`;
  if (!sub) return json(400, { error: "invalid_grant", error_description: "bad id token" });
  const fresh = await uuidFor(provider, sub);
  try {
    const userId = await pool(bridge).begin(async (tx) => {
      const found = await tx<Array<{ user_id: string }>>`
        select user_id from auth.identities where provider = ${provider} and provider_id = ${sub}`;
      if (found.length === 1) return found[0].user_id;
      const byEmail = await tx<Array<{ id: string }>>`
        select id from auth.users where lower(email) = lower(${email}) order by id limit 1`;
      const uid = byEmail.length === 1 ? byEmail[0].id : fresh;
      if (byEmail.length === 0) {
        await tx`
          insert into auth.users (id, email, raw_app_meta_data)
          values (${uid}::uuid, ${email}, ${tx.json({ provider, providers: [provider] })})
          on conflict (id) do nothing`;
      }
      await tx`
        insert into auth.identities (provider_id, user_id, provider, identity_data)
        values (${sub}, ${uid}::uuid, ${provider}, ${tx.json({ sub, email })})
        on conflict (provider_id, provider) do nothing`;
      const again = await tx<Array<{ user_id: string }>>`
        select user_id from auth.identities where provider = ${provider} and provider_id = ${sub}`;
      return again[0].user_id;
    });
    bridge.signups += 1;
    if (!h.fake.users.has(userId)) h.fake.users.set(userId, { id: userId, email, provider });
    const session = h.fake.mintSession(userId, provider);
    h.fake.log("gotrue.id_token", `user=${userId} session=${session.sessionId} (pg)`);
    return json(200, h.fake.sessionJson(session));
  } catch (error) {
    const e = error as { code?: string; message?: string };
    bridge.pgErrors[e.code ?? "XX000"] = (bridge.pgErrors[e.code ?? "XX000"] ?? 0) + 1;
    h.fake.log("gotrue.id_token", `pg error ${e.code}: ${e.message}`);
    return json(500, { error: "server_error", error_description: e.message ?? String(error) });
  }
}

/** One pool per Deno.test (opened in scenario(), closed in its finally) so
 * the resource sanitizer stays on; sized so every lane can hold its own
 * connection at once. */
function newPool(): Sql {
  return postgres(PG_URL, { max: STRESS_LANES * 2 + 8, onnotice: () => {} });
}

function pool(bridge: Bridge): Sql {
  if (!bridge.sql) throw new Error("bridge: no pool open (route called outside a scenario)");
  return bridge.sql;
}

async function harness(): Promise<{ h: XcHarness; bridge: Bridge }> {
  if (loaded) return loaded;
  await installAppleServerEnv();
  const h = await loadXcHarness();
  const bridge: Bridge = {
    sql: null,
    apple: { calls: 0, grants: [] },
    pgErrors: {},
    providerPatches: [],
    signups: 0,
  };
  const original = h.fake.handleFetch.bind(h.fake);
  h.fake.handleFetch = async (request: Request, rawBody: string): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin === "https://appleid.apple.com" && url.pathname === "/auth/token") {
      h.fake.count("apple.token");
      if (STRESS_LATENCY > 0) await sleep(h.fake.prng.int(0, STRESS_LATENCY));
      return appleTokenResponse(rawBody, bridge.apple);
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "id_token") {
      return signupBridge(h, bridge, rawBody);
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      return restBridge(h, bridge, request, rawBody);
    }
    return original(request, rawBody);
  };
  loaded = { h, bridge };
  return loaded;
}

// ── DB fixtures / probes (owner role) ────────────────────────────────────────

async function purgeIdentity(sql: Sql, provider: string, sub: string): Promise<void> {
  await sql`delete from auth.users u using auth.identities i
    where i.user_id = u.id and i.provider = ${provider} and i.provider_id = ${sub}`;
  await sql`delete from auth.users where id = ${await uuidFor(provider, sub)}::uuid`;
  await sql`delete from public.free_rating_ledger
    where identity_hash = public.free_rating_identity_hash(${provider}, ${sub})`;
}

async function purgeUser(sql: Sql, userId: string): Promise<void> {
  await sql`delete from auth.users where id = ${userId}::uuid`;
}

async function linkedUser(
  sql: Sql,
  userId: string,
  email: string,
  identities: Array<{ provider: string; sub: string }>,
  provider: string,
): Promise<void> {
  await purgeUser(sql, userId);
  for (const i of identities) await purgeIdentity(sql, i.provider, i.sub);
  await sql`insert into auth.users (id, email, raw_app_meta_data)
    values (${userId}::uuid, ${email}, ${sql.json({ provider, providers: [provider] })})`;
  for (const i of identities) {
    await sql`insert into auth.identities (provider_id, user_id, provider, identity_data)
      values (${i.sub}, ${userId}::uuid, ${i.provider}, ${sql.json({ sub: i.sub, email })})`;
  }
}

interface DbState {
  users: number;
  identities: number;
  profiles: Array<{ id: string; provider: string; email: string | null }>;
  credentials: Array<{
    user_id: string;
    apple_refresh_token_encrypted: string;
    apple_revoked_at: string | null;
  }>;
  permits: number;
  scoredShots: number;
  ledger: Array<{ identity_hash: string; scored_count: number }>;
  lifetimeScored: number;
}

async function dbState(
  sql: Sql,
  userIds: string[],
  identities: Array<{ provider: string; sub: string }>,
): Promise<DbState> {
  const ids = userIds.map((u) => `'${u}'::uuid`).join(", ") || "null::uuid";
  const users = await sql.unsafe(`select count(*)::int as n from auth.users where id in (${ids})`);
  const idents = await sql.unsafe(
    `select count(*)::int as n from auth.identities where user_id in (${ids})`,
  );
  const profiles = await sql.unsafe(
    `select id::text, provider, email from public.profiles where id in (${ids}) order by id`,
  );
  const credentials = await sql.unsafe(
    `select user_id::text, apple_refresh_token_encrypted, apple_revoked_at::text from public.account_external_credentials where user_id in (${ids})`,
  );
  const permits = await sql.unsafe(
    `select count(*)::int as n from public.analysis_permits where user_id in (${ids})`,
  );
  const shots = await sql.unsafe(
    `select count(*)::int as n from public.shots where user_id in (${ids}) and result_kind = 'scored'`,
  );
  const ledger: Array<{ identity_hash: string; scored_count: number }> = [];
  for (const i of identities) {
    const rows = await sql`select identity_hash, scored_count from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash(${i.provider}, ${i.sub})`;
    for (const r of rows)
      ledger.push({ identity_hash: String(r.identity_hash), scored_count: Number(r.scored_count) });
  }
  let lifetimeScored = 0;
  if (userIds.length === 1) {
    lifetimeScored = await sql.begin(async (tx) => {
      await actAs(tx, { role: "user", userId: userIds[0] });
      const rows = await tx`select public.lifetime_scored_count() as n`;
      return Number(rows[0].n);
    });
  }
  return {
    users: Number(users[0].n),
    identities: Number(idents[0].n),
    profiles: profiles.map((p) => ({
      id: String(p.id),
      provider: String(p.provider),
      email: p.email === null ? null : String(p.email),
    })),
    credentials: credentials.map((c) => ({
      user_id: String(c.user_id),
      apple_refresh_token_encrypted: String(c.apple_refresh_token_encrypted),
      apple_revoked_at: c.apple_revoked_at === null ? null : String(c.apple_revoked_at),
    })),
    permits: Number(permits[0].n),
    scoredShots: Number(shots[0].n),
    ledger,
    lifetimeScored,
  };
}

// ── Scenario driver ──────────────────────────────────────────────────────────

type RoundFn = (ctx: {
  h: XcHarness;
  bridge: Bridge;
  sql: Sql;
  prng: Prng;
  round: number;
  seed: number;
  rows: LaneRow[];
  invariants: Invariant[];
  observations: Record<string, unknown>;
  ip: (lane: number) => string;
}) => Promise<void>;

async function scenario(name: string, run: RoundFn): Promise<RoundReport[]> {
  const { h, bridge } = await harness();
  const hash = fnv1a(name);
  const reports: RoundReport[] = [];
  const sql = newPool();
  bridge.sql = sql;
  try {
    for (const round of roundsToRun()) {
      const seed = roundSeed(STRESS_SEED, name, round);
      resetFake(h.fake, seed);
      bridge.apple = { calls: 0, grants: [] };
      bridge.pgErrors = {};
      bridge.providerPatches = [];
      bridge.signups = 0;
      const prng = new Prng(seed);
      const rows: LaneRow[] = [];
      const invariants: Invariant[] = [];
      const observations: Record<string, unknown> = {};
      const ip = (lane: number) =>
        `10.${hash & 255}.${(((hash >> 8) & 15) << 4) | (round & 15)}.${1 + (lane % 250)}`;
      const { timedOut, wallMs } = await withDeadline(
        `${name}#${round}`,
        run({ h, bridge, sql, prng, round, seed, rows, invariants, observations, ip }),
      );
      inv(
        invariants,
        "no-pg-errors-or-deadlocks",
        Object.keys(bridge.pgErrors).length === 0,
        JSON.stringify(bridge.pgErrors),
      );
      observations.pgErrors = { ...bridge.pgErrors };
      const report = summarize(
        FILE,
        name,
        round,
        seed,
        STRESS_LANES,
        rows,
        invariants,
        observations,
        { ...h.fake.counters },
        wallMs,
        timedOut,
      );
      printRound(report);
      reports.push(report);
    }
  } finally {
    bridge.sql = null;
    await sql.end({ timeout: 5 });
  }
  const path = await writeRounds(FILE, name, reports);
  console.log(`[stress] ${name}: ${reports.length} rounds → ${path}`);
  return reports;
}

function assertAllHeld(reports: RoundReport[]): void {
  const broken = reports
    .filter((r) => r.outcome === "BROKEN")
    .map(
      (r) =>
        `round=${r.round} seed=${r.seed} failed=${r.failed.join(",")} replay: XC_PG_URL=… ${r.replay}`,
    );
  assertEquals(broken, []);
}

const no5xx = (rows: LaneRow[]) => rows.filter((r) => r.status >= 500 || r.status < 0);

async function credentialBound(
  state: DbState,
  userId: string,
  grants: string[],
): Promise<Invariant> {
  const creds = state.credentials.filter((c) => c.user_id === userId);
  const name = `one-credential-row:${userId.slice(0, 8)}`;
  if (creds.length !== 1) return { name, holds: false, detail: `rows=${creds.length}` };
  try {
    const plain = await decryptAppleRefreshToken(
      creds[0].apple_refresh_token_encrypted,
      userId,
      Deno.env.get("APPLE_TOKEN_ENCRYPTION_KEY") ?? "",
    );
    return {
      name,
      holds: grants.includes(plain) && creds[0].apple_revoked_at === null,
      detail: `decrypts to ${plain} issued=${grants.includes(plain)} revoked_at=${creds[0].apple_revoked_at}`,
    };
  } catch (error) {
    return { name, holds: false, detail: `does not decrypt under user AAD: ${String(error)}` };
  }
}

function noSpend(
  state: DbState,
  userId: string,
  invariants: Invariant[],
  expectedLifetime = 0,
): void {
  inv(
    invariants,
    `no-double-spend:${userId.slice(0, 8)}`,
    state.permits === 0 && state.scoredShots === 0 && state.lifetimeScored === expectedLifetime,
    `permits=${state.permits} scoredShots=${state.scoredShots} lifetime_scored_count()=${state.lifetimeScored} expected=${expectedLifetime}`,
  );
}

async function accessProbe(h: XcHarness, token: string, ip: string) {
  const response = await h.handler(edgeGet("/v1/me/access", token, ip));
  const body = await readJson(response);
  const free = isRecord(body.freeRatings) ? body.freeRatings : {};
  return {
    status: response.status,
    used: Number(free.used ?? -1),
    reserved: Number(free.reserved ?? -1),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
Deno.test({
  name: "stress P1 dup-signup-burst (pg) — N first sign-ins of one identity: one auth.users, one profiles row, N sessions, access_state used=0",
  ignore,
  async fn() {
    const reports = await scenario("P1-dup-signup-burst", async (c) => {
      const sub = `g-${c.prng.uuid()}`;
      await purgeIdentity(c.sql, "google", sub);
      const uid = await uuidFor("google", sub);
      const results = await jittered(c.prng, STRESS_LANES, 0, (lane) =>
        timed(c.rows, c.round, lane, "bootstrap", () =>
          c.h.handler(
            bootstrapRequest({
              token: providerIdToken("google", sub, { nonce: `${c.seed}-${lane}` }),
              ip: c.ip(lane),
            }),
          ),
        ),
      );
      const ok = results.filter((r) => r.status === 200);
      inv(
        c.invariants,
        "all-200",
        ok.length === STRESS_LANES,
        `200s=${ok.length}/${STRESS_LANES} ${JSON.stringify(results.filter((r) => r.status !== 200).map((r) => `${r.status}:${r.row.code}`))}`,
      );
      inv(c.invariants, "no-5xx", no5xx(c.rows).length === 0, "");
      inv(
        c.invariants,
        "no-cross-user",
        ok.every((r) => r.row.userId === uid),
        JSON.stringify([...new Set(ok.map((r) => r.row.userId))]),
      );
      const sids = ok.map((r) => sessionOf(r.body).sessionId);
      inv(
        c.invariants,
        "one-fresh-session-per-call",
        new Set(sids).size === ok.length,
        `distinct=${new Set(sids).size}`,
      );
      const state = await dbState(c.sql, [uid], [{ provider: "google", sub }]);
      inv(c.invariants, "one-auth-user", state.users === 1, `auth.users=${state.users}`);
      inv(
        c.invariants,
        "one-identity",
        state.identities === 1,
        `auth.identities=${state.identities}`,
      );
      inv(
        c.invariants,
        "one-profile-row",
        state.profiles.length === 1 && state.profiles[0].provider === "google",
        JSON.stringify(state.profiles),
      );
      inv(
        c.invariants,
        "no-provider-patch-needed",
        c.bridge.providerPatches.length === 0,
        `patches=${c.bridge.providerPatches.length}`,
      );
      const probes = await Promise.all(
        ok.map((r, i) => accessProbe(c.h, sessionOf(r.body).accessToken, c.ip(i))),
      );
      inv(
        c.invariants,
        "all-sessions-usable-access-state",
        probes.every((p) => p.status === 200 && p.used === 0 && p.reserved === 0),
        JSON.stringify(probes.slice(0, 4)),
      );
      inv(
        c.invariants,
        "no-ledger-row-for-new-identity",
        state.ledger.length === 0,
        JSON.stringify(state.ledger),
      );
      noSpend(state, uid, c.invariants);
      c.observations.signups = c.bridge.signups;
    });
    assertAllHeld(reports);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
Deno.test({
  name: "stress P2 provider-flip (pg) — one account, jittered Google/Apple bootstraps: last-writer-wins provider, one credential row bound to user, no deadlock",
  ignore,
  async fn() {
    const reports = await scenario("P2-provider-flip", async (c) => {
      const gsub = `g-${c.prng.uuid()}`;
      const asub = `a-${c.prng.uuid()}`;
      const uid = c.prng.uuid();
      const email = `${uid.slice(0, 8)}@flip.example.com`;
      await linkedUser(
        c.sql,
        uid,
        email,
        [
          { provider: "google", sub: gsub },
          { provider: "apple", sub: asub },
        ],
        "google",
      );
      const providers = Array.from({ length: STRESS_LANES }, () =>
        c.prng.next() < 0.5 ? "google" : "apple",
      ) as Array<"google" | "apple">;
      const results = await jittered(c.prng, STRESS_LANES, 4 * STRESS_LATENCY + 40, (lane, d) => {
        const provider = providers[lane];
        const nonce = `${c.seed}-${lane}`;
        const sub = provider === "google" ? gsub : asub;
        return timed(
          c.rows,
          c.round,
          lane,
          `bootstrap:${provider}`,
          () =>
            c.h.handler(
              bootstrapRequest({
                token: providerIdToken(provider, sub, { nonce, email }),
                ip: c.ip(lane),
                body:
                  provider === "apple"
                    ? { appleAuthorizationCode: appleCode("ok", sub, nonce) }
                    : {},
                headers: provider === "apple" ? { "X-Apple-Revocation-Protocol": "1" } : {},
              }),
            ),
          d,
        );
      });
      const ok = results.filter((r) => r.status === 200);
      inv(
        c.invariants,
        "all-200",
        ok.length === STRESS_LANES,
        `200s=${ok.length}/${STRESS_LANES} ${JSON.stringify(results.filter((r) => r.status !== 200).map((r) => `${r.status}:${r.row.code}`))}`,
      );
      inv(c.invariants, "no-5xx", no5xx(c.rows).length === 0, "");
      inv(
        c.invariants,
        "no-cross-user",
        ok.every((r) => r.row.userId === uid),
        "",
      );
      inv(
        c.invariants,
        "one-fresh-session-per-call",
        new Set(ok.map((r) => sessionOf(r.body).sessionId)).size === ok.length,
        "",
      );
      const state = await dbState(
        c.sql,
        [uid],
        [
          { provider: "google", sub: gsub },
          { provider: "apple", sub: asub },
        ],
      );
      inv(
        c.invariants,
        "one-auth-user-two-identities",
        state.users === 1 && state.identities === 2,
        `users=${state.users} identities=${state.identities}`,
      );
      const expected = c.bridge.providerPatches.at(-1)?.provider ?? "google";
      inv(
        c.invariants,
        "no-lost-update",
        state.profiles.length === 1 && state.profiles[0].provider === expected,
        `profiles=${JSON.stringify(state.profiles)} lastCommittedPatch=${expected} patches=${c.bridge.providerPatches.length}`,
      );
      const appleLanes = providers.filter((p) => p === "apple").length;
      inv(
        c.invariants,
        "apple-exchange-per-apple-lane",
        c.bridge.apple.calls === appleLanes,
        `apple.calls=${c.bridge.apple.calls} lanes=${appleLanes}`,
      );
      if (appleLanes > 0)
        c.invariants.push(await credentialBound(state, uid, c.bridge.apple.grants));
      else
        inv(
          c.invariants,
          "no-credential-row-without-apple",
          state.credentials.length === 0,
          `rows=${state.credentials.length}`,
        );
      noSpend(state, uid, c.invariants);
      c.observations.finalProvider = state.profiles[0]?.provider ?? null;
      c.observations.providerPatches = c.bridge.providerPatches.length;
      c.observations.appleLanes = appleLanes;
    });
    assertAllHeld(reports);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
Deno.test({
  name: "stress P3 two-actors (pg) — accounts A/B × devices with provider flips: RLS keeps every write on its own row, credentials bound per user",
  ignore,
  async fn() {
    const reports = await scenario("P3-two-actors", async (c) => {
      const actors = ["A", "B"].map((tag) => {
        const uid = c.prng.uuid();
        return {
          tag,
          uid,
          email: `${uid.slice(0, 8)}@${tag.toLowerCase()}.example.com`,
          gsub: `g-${c.prng.uuid()}`,
          asub: `a-${c.prng.uuid()}`,
          initial: tag === "A" ? "google" : "apple",
        };
      });
      for (const a of actors) {
        await linkedUser(
          c.sql,
          a.uid,
          a.email,
          [
            { provider: "google", sub: a.gsub },
            { provider: "apple", sub: a.asub },
          ],
          a.initial,
        );
      }
      const plan = Array.from({ length: STRESS_LANES }, (_, lane) => ({
        actor: actors[lane % 2],
        provider: (c.prng.next() < 0.5 ? "google" : "apple") as "google" | "apple",
      }));
      const results = await jittered(c.prng, STRESS_LANES, 2 * STRESS_LATENCY + 10, (lane, d) => {
        const p = plan[lane];
        const nonce = `${c.seed}-${lane}`;
        const sub = p.provider === "google" ? p.actor.gsub : p.actor.asub;
        return timed(
          c.rows,
          c.round,
          lane,
          `bootstrap:${p.actor.tag}:${p.provider}`,
          () =>
            c.h.handler(
              bootstrapRequest({
                token: providerIdToken(p.provider, sub, { nonce, email: p.actor.email }),
                ip: c.ip(lane),
                body:
                  p.provider === "apple"
                    ? { appleAuthorizationCode: appleCode("ok", sub, nonce) }
                    : {},
                headers: p.provider === "apple" ? { "X-Apple-Revocation-Protocol": "1" } : {},
              }),
            ),
          d,
        ).then((r) => ({ ...r, plan: p }));
      });
      const ok = results.filter((r) => r.status === 200);
      inv(
        c.invariants,
        "all-200",
        ok.length === STRESS_LANES,
        `200s=${ok.length} ${JSON.stringify(results.filter((r) => r.status !== 200).map((r) => `${r.status}:${r.row.code}`))}`,
      );
      inv(c.invariants, "no-5xx", no5xx(c.rows).length === 0, "");
      inv(
        c.invariants,
        "no-cross-user",
        ok.every((r) => r.row.userId === r.plan.actor.uid),
        "",
      );
      inv(
        c.invariants,
        "one-fresh-session-per-call",
        new Set(ok.map((r) => sessionOf(r.body).sessionId)).size === ok.length,
        "",
      );
      const state = await dbState(
        c.sql,
        actors.map((a) => a.uid),
        [],
      );
      inv(
        c.invariants,
        "two-users-two-profiles",
        state.users === 2 && state.profiles.length === 2,
        `users=${state.users} profiles=${state.profiles.length}`,
      );
      for (const a of actors) {
        const row = state.profiles.find((p) => p.id === a.uid);
        const expected =
          c.bridge.providerPatches.filter((p) => p.userId === a.uid).at(-1)?.provider ?? a.initial;
        inv(
          c.invariants,
          `no-lost-update:${a.tag}`,
          row?.provider === expected,
          `provider=${row?.provider} lastCommittedPatch=${expected}`,
        );
        if (plan.some((p) => p.actor === a && p.provider === "apple")) {
          const own = c.bridge.apple.grants.filter((g) => g.includes(`-${a.asub}-`));
          c.invariants.push(await credentialBound(state, a.uid, own));
        }
      }
      inv(
        c.invariants,
        "credential-rows-lte-users",
        state.credentials.length <= 2,
        `rows=${state.credentials.length}`,
      );
      inv(
        c.invariants,
        "no-double-spend",
        state.permits === 0 && state.scoredShots === 0,
        `permits=${state.permits} scored=${state.scoredShots}`,
      );
      // Each session resolves to ITS user on a protected route.
      const probes = await Promise.all(
        ok.map(async (r, i) => {
          const response = await c.h.handler(
            edgeGet("/v1/me", sessionOf(r.body).accessToken, c.ip(i)),
          );
          const body = await readJson(response);
          const user = isRecord(body.user) ? body.user : {};
          return {
            status: response.status,
            ok: response.status === 200 && user.id === r.plan.actor.uid,
          };
        }),
      );
      inv(
        c.invariants,
        "sessions-bound-to-own-user",
        probes.every((p) => p.ok),
        JSON.stringify(probes.filter((p) => !p.ok).map((p) => p.status)),
      );
    });
    assertAllHeld(reports);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
Deno.test({
  name: "stress P4 cancel-then-retry (pg) — client aborts mid-flight then retries: every lane settles, retries 200, one profile row, one credential row",
  ignore,
  async fn() {
    const reports = await scenario("P4-cancel-then-retry", async (c) => {
      const gsub = `g-${c.prng.uuid()}`;
      const asub = `a-${c.prng.uuid()}`;
      const uid = c.prng.uuid();
      const email = `${uid.slice(0, 8)}@cancel.example.com`;
      await linkedUser(
        c.sql,
        uid,
        email,
        [
          { provider: "google", sub: gsub },
          { provider: "apple", sub: asub },
        ],
        "google",
      );
      const results = await jittered(c.prng, STRESS_LANES, 0, async (lane) => {
        const apple = c.prng.next() < 0.5;
        const provider = apple ? "apple" : "google";
        const sub = apple ? asub : gsub;
        const nonce = `${c.seed}-${lane}`;
        const controller = new AbortController();
        const abortAt = c.prng.int(0, 3 * STRESS_LATENCY + 10);
        const first = timed(c.rows, c.round, lane, `bootstrap:${provider}:aborted@${abortAt}`, () =>
          c.h.handler(
            bootstrapRequest({
              token: providerIdToken(provider, sub, { nonce, email }),
              ip: c.ip(lane),
              body: apple ? { appleAuthorizationCode: appleCode("ok", sub, nonce) } : {},
              headers: apple ? { "X-Apple-Revocation-Protocol": "1" } : {},
              signal: controller.signal,
            }),
          ),
        );
        await sleep(abortAt);
        controller.abort(new DOMException("client went away", "AbortError"));
        const aborted = await first;
        const retry = await timed(c.rows, c.round, lane, `retry:${provider}`, () =>
          c.h.handler(
            bootstrapRequest({
              token: providerIdToken(provider, sub, { nonce: `${nonce}-retry`, email }),
              ip: c.ip(lane),
              body: apple ? { appleAuthorizationCode: appleCode("ok", sub, `${nonce}-retry`) } : {},
              headers: apple ? { "X-Apple-Revocation-Protocol": "1" } : {},
            }),
          ),
        );
        return { aborted, retry, apple };
      });
      const retries = results.map((r) => r.retry);
      inv(
        c.invariants,
        "every-lane-settled",
        c.rows.every((r) => r.status !== -1),
        JSON.stringify(c.rows.filter((r) => r.status === -1).map((r) => r.note)),
      );
      inv(
        c.invariants,
        "retries-all-200",
        retries.every((r) => r.status === 200),
        JSON.stringify(retries.map((r) => `${r.status}:${r.row.code ?? ""}`)),
      );
      inv(c.invariants, "no-5xx", no5xx(c.rows).length === 0, "");
      const all200 = [...results.map((r) => r.aborted), ...retries].filter((r) => r.status === 200);
      inv(
        c.invariants,
        "one-fresh-session-per-200",
        new Set(all200.map((r) => sessionOf(r.body).sessionId)).size === all200.length,
        "",
      );
      inv(
        c.invariants,
        "no-cross-user",
        all200.every((r) => r.row.userId === uid),
        "",
      );
      const state = await dbState(
        c.sql,
        [uid],
        [
          { provider: "google", sub: gsub },
          { provider: "apple", sub: asub },
        ],
      );
      const expected = c.bridge.providerPatches.at(-1)?.provider ?? "google";
      inv(
        c.invariants,
        "one-profile-row-no-lost-update",
        state.profiles.length === 1 && state.profiles[0].provider === expected,
        JSON.stringify(state.profiles),
      );
      if (results.some((r) => r.apple))
        c.invariants.push(await credentialBound(state, uid, c.bridge.apple.grants));
      noSpend(state, uid, c.invariants);
      c.observations.abortedStatusHistogram = results.reduce<Record<string, number>>((acc, r) => {
        acc[String(r.aborted.status)] = (acc[String(r.aborted.status)] ?? 0) + 1;
        return acc;
      }, {});
    });
    assertAllHeld(reports);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
Deno.test({
  name: "stress P5 late-link-ledger (pg) — Apple identity auto-links to a Google account that spent both free ratings while both providers bootstrap: lifetime count stays 2, one user, one profile",
  ignore,
  async fn() {
    const reports = await scenario("P5-late-link-ledger", async (c) => {
      const gsub = `g-${c.prng.uuid()}`;
      const asub = `a-${c.prng.uuid()}`;
      const uid = c.prng.uuid();
      const email = `${uid.slice(0, 8)}@link.example.com`;
      await linkedUser(c.sql, uid, email, [{ provider: "google", sub: gsub }], "google");
      await purgeIdentity(c.sql, "apple", asub);
      // The Google identity already spent both lifetime free ratings.
      await c.sql`insert into public.free_rating_ledger (identity_hash, scored_count)
        values (public.free_rating_identity_hash('google', ${gsub}), 2)`;
      const providers = Array.from({ length: STRESS_LANES }, (_, i) =>
        i % 2 === 0 ? "google" : "apple",
      ) as Array<"google" | "apple">;
      const results = await jittered(c.prng, STRESS_LANES, 2 * STRESS_LATENCY + 10, (lane, d) => {
        const provider = providers[lane];
        const sub = provider === "google" ? gsub : asub;
        const nonce = `${c.seed}-${lane}`;
        return timed(
          c.rows,
          c.round,
          lane,
          `bootstrap:${provider}`,
          () =>
            c.h.handler(
              bootstrapRequest({
                token: providerIdToken(provider, sub, { nonce, email }),
                ip: c.ip(lane),
                body:
                  provider === "apple"
                    ? { appleAuthorizationCode: appleCode("ok", sub, nonce) }
                    : {},
                headers: provider === "apple" ? { "X-Apple-Revocation-Protocol": "1" } : {},
              }),
            ),
          d,
        );
      });
      const ok = results.filter((r) => r.status === 200);
      inv(
        c.invariants,
        "all-200",
        ok.length === STRESS_LANES,
        `200s=${ok.length} ${JSON.stringify(results.filter((r) => r.status !== 200).map((r) => `${r.status}:${r.row.code}`))}`,
      );
      inv(c.invariants, "no-5xx", no5xx(c.rows).length === 0, "");
      inv(
        c.invariants,
        "apple-linked-not-new-account",
        ok.every((r) => r.row.userId === uid),
        JSON.stringify([...new Set(ok.map((r) => r.row.userId))]),
      );
      const state = await dbState(
        c.sql,
        [uid],
        [
          { provider: "google", sub: gsub },
          { provider: "apple", sub: asub },
        ],
      );
      inv(
        c.invariants,
        "one-user-two-identities",
        state.users === 1 && state.identities === 2,
        `users=${state.users} identities=${state.identities}`,
      );
      inv(
        c.invariants,
        "one-profile-row",
        state.profiles.length === 1,
        JSON.stringify(state.profiles),
      );
      inv(
        c.invariants,
        "ledger-inherited-by-linked-identity",
        state.ledger.length === 2 && state.ledger.every((l) => l.scored_count === 2),
        JSON.stringify(state.ledger),
      );
      // Bootstrap must neither spend nor reset: lifetime stays exactly 2.
      noSpend(state, uid, c.invariants, 2);
      const probes = await Promise.all(
        ok.map((r, i) => accessProbe(c.h, sessionOf(r.body).accessToken, c.ip(i))),
      );
      inv(
        c.invariants,
        "access-state-used-2-for-every-session",
        probes.every((p) => p.status === 200 && p.used === 2 && p.reserved === 0),
        JSON.stringify(probes.slice(0, 4)),
      );
      if (providers.includes("apple"))
        c.invariants.push(await credentialBound(state, uid, c.bridge.apple.grants));
      c.observations.finalProvider = state.profiles[0]?.provider ?? null;
      c.observations.ledger = state.ledger;
    });
    assertAllHeld(reports);
  },
});
