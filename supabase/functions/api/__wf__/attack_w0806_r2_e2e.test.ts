// W08-06 ADVERSARY (round 2, candidate 4d7ccb87) — end to end on the REAL wire.
//
// The shipping Edge handler (index.ts, loaded through routesHarness) is driven
// against a genuine PostgREST (./attack_w0806_r2_pgrst_up.sh) in front of the
// disposable Postgres with every migration applied (./xc_pg_up.sh). Only the
// GoTrue admin call is emulated (`delete from auth.users`, which is what the
// hosted admin API does), Apple/RevenueCat stay faked. Everything the candidate
// claims about the sweep — owner-bearer RLS reads, `x-pickle-api-key`, keyset
// `or=(…)` filters, max_rows clamping, the SQL lease/receipt state machine —
// is exercised by the real components here, not by the in-process stand-in.
//
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//   XC_PGRST_URL=http://127.0.0.1:3011 \
//   XC_PGRST_JWT_SECRET=w0806-attack-jwt-secret-at-least-32-bytes-long \
//     deno test -A --config deno.json attack_w0806_r2_e2e.test.ts
//
// Without all three variables every test is `ignore`d — an ignored run is NOT a
// pass. Every test asserts the EXPECTED behaviour: a test that fails on
// 4d7ccb87 is a confirmed break (its `BREAK` comment names the invariant), a
// test that passes is an attack the candidate survived.
import postgres from "postgres";
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import {
  ACCOUNT_DELETION_UNREAD_TABLES,
  ACCOUNT_OWNER_NAMESPACES,
  INVENTORY_READ_ATTEMPTS,
  postgrestFilterValue,
} from "../accountDeletionOperations.ts";
import { PRIVACY_POLICY_TEXT, SUPPORT_TEXT, TERMS_TEXT } from "../legal.ts";
import {
  captureConsole,
  loadHarness,
  RC_URL,
  type RecordedCall,
  SUPABASE_URL,
  userRequest,
} from "./routesHarness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? "";
const PGRST_URL = (Deno.env.get("XC_PGRST_URL") ?? "").replace(/\/+$/, "");
const JWT_SECRET = Deno.env.get("XC_PGRST_JWT_SECRET") ?? "";
const ignore = PG_URL === "" || PGRST_URL === "" || JWT_SECRET === "";

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;

const h = await loadHarness();
const REST = `${SUPABASE_URL}/rest/v1/`;
const NAMESPACE_TABLES = new Set(ACCOUNT_OWNER_NAMESPACES.map((namespace) => namespace.table));

// ─── helpers ─────────────────────────────────────────────────────────────────

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** HS256 JWT PostgREST accepts for its `PGRST_JWT_SECRET`. */
async function signJwt(claims: Record<string, unknown>): Promise<string> {
  const enc = new TextEncoder();
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(
    enc.encode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

const userJwt = (sub: string, sessionId: string) =>
  signJwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    role: "authenticated",
    aud: "authenticated",
    sub,
    session_id: sessionId,
  });
const serviceJwt = () => signJwt({ role: "service_role" });

function connect(): Sql {
  return postgres(PG_URL, { max: 1, onnotice: () => {} });
}

/** Hosted `auth.uid()` reads the JWT `sub` from `request.jwt.claims` (what
 * PostgREST ≥ 9 sets on PG ≥ 14); the repo shim only reads the legacy
 * `request.jwt.claim.sub`. Make the shim behave like production so the real
 * PostgREST path resolves the owner. Superset of the shim's behaviour. */
async function hostedUid(sql: Sql): Promise<void> {
  await sql.unsafe(`create or replace function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    )::uuid $$`);
}

interface Owner {
  id: string;
  sessionId: string;
  providerId: string;
  jwt: string;
}

async function seedOwner(sql: Sql, tag: string, drills = 3): Promise<Owner> {
  const id = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const providerId = `w0806-${tag}-${id.slice(0, 8)}`;
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values
       ('${id}', '${tag}-${id.slice(0, 8)}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider_id, user_id, provider, identity_data) values
       ('${providerId}', '${id}', 'google', '{"sub":"${providerId}"}')`,
  );
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${sessionId}', '${id}')`);
  await sql.unsafe(
    `insert into public.profiles (id, provider, email, display_name) values
       ('${id}', 'google', '${tag}@example.com', 'W0806 ${tag}')
     on conflict (id) do update set provider = excluded.provider`,
  );
  await sql.unsafe(
    `insert into public.sessions (id, user_id, kind, started_at) values
       ('${crypto.randomUUID()}', '${id}', 'practice', now()),
       ('${crypto.randomUUID()}', '${id}', 'practice', now() - interval '1 day')`,
  );
  if (drills > 0) {
    await sql.unsafe(
      `insert into public.user_saved_drills (user_id, slug)
         select '${id}', 'drill-' || lpad(g::text, 5, '0') from generate_series(1, ${drills}) g`,
    );
  }
  await sql.unsafe(
    `insert into public.evaluation_trials (id, user_id, payload) values
       ('${crypto.randomUUID()}', '${id}', '{"kind":"w0806"}')`,
  );
  await sql.unsafe(
    `insert into public.billing_entitlements (user_id, premium) values ('${id}', false)`,
  );
  return { id, sessionId, providerId, jwt: await userJwt(id, sessionId) };
}

async function ownerRowCounts(sql: Sql, ownerId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const namespace of ACCOUNT_OWNER_NAMESPACES) {
    const rows = await sql.unsafe(
      `select count(*)::int as n from public.${namespace.table} where ${namespace.ownerColumn} = '${ownerId}'`,
    );
    counts[namespace.table] = rows[0].n as number;
  }
  return counts;
}

async function operationRow(sql: Sql, operationId: string): Promise<Row> {
  const rows = await sql.unsafe(
    `select phase, completed_at, auth_deleted_at, lease_token, last_error_code, attempts
       from api_private.account_deletion_operations where id = '${operationId}'`,
  );
  return rows[0] as Row;
}

/** The RPC refuses a confirm within 3 s of the request; move the row back
 * consistently with its check constraints (all four timestamps together). */
async function ageOperation(sql: Sql, operationId: string): Promise<void> {
  await sql.unsafe(
    `update api_private.account_deletion_operations set
       created_at = created_at - interval '10 seconds',
       challenge_expires_at = challenge_expires_at - interval '10 seconds',
       status_expires_at = status_expires_at - interval '10 seconds',
       retain_until = retain_until - interval '10 seconds'
     where id = '${operationId}'`,
  );
}

interface Requested {
  challenge: string;
  operationId: string;
  statusCapability: string;
}

async function requestDeletion(owner: Owner, ip: string): Promise<Requested> {
  const response = await h.handler(
    userRequest("POST", "/v1/me/delete-request", { token: owner.jwt, body: {}, ip }),
  );
  assertEquals(response.status, 200, await response.clone().text());
  return (await response.json()) as Requested;
}

function confirmDeletion(owner: Owner, requested: Requested, ip: string): Promise<Response> {
  return h.handler(
    userRequest("POST", "/v1/me/delete-confirm", {
      token: owner.jwt,
      body: { challenge: requested.challenge, operationId: requested.operationId },
      ip,
    }),
  );
}

function deletionStatus(requested: Requested, ip: string): Promise<Response> {
  return h.handler(
    userRequest("POST", "/v1/me/delete-status", {
      token: requested.statusCapability,
      body: { operationId: requested.operationId },
      ip,
    }),
  );
}

interface WireRead {
  table: string;
  authorization: string;
  apiKey: string | undefined;
  search: string;
  status: number;
  afterAuthDelete: boolean;
}

interface LiveWire {
  reads: WireRead[];
  authDeleted: string[];
  /** Serve a canned reply for a call (return null to let it reach PostgREST). */
  override: (call: RecordedCall, context: { afterAuthDelete: boolean }) => Response | null;
}

/** Route every Supabase REST call the handler makes to the real PostgREST
 * (service key → service_role JWT) and emulate the GoTrue admin delete. */
function liveWire(sql: Sql, service: string): LiveWire {
  const wire: LiveWire = { reads: [], authDeleted: [], override: () => null };
  h.respond = async (call) => {
    const afterAuthDelete = wire.authDeleted.length > 0;
    const canned = wire.override(call, { afterAuthDelete });
    if (canned) {
      if (call.method === "GET" && call.url.startsWith(REST)) {
        wire.reads.push(readOf(call, canned.status, afterAuthDelete));
      }
      return canned;
    }
    if (call.method === "DELETE" && call.url.startsWith(`${SUPABASE_URL}/auth/v1/admin/users/`)) {
      const ownerId = decodeURIComponent(
        new URL(call.url).pathname.slice("/auth/v1/admin/users/".length),
      );
      await sql.unsafe(`delete from auth.users where id = '${ownerId}'`);
      wire.authDeleted.push(ownerId);
      return Response.json({}, { status: 200 });
    }
    if (!call.url.startsWith(REST)) return null;
    const target = new URL(call.url);
    const upstream = new URL(PGRST_URL);
    upstream.pathname = target.pathname.slice("/rest/v1".length);
    upstream.search = target.search;
    const headers = new Headers();
    for (const [name, value] of Object.entries(call.headers)) {
      if (name === "host" || name === "content-length" || name === "apikey") continue;
      headers.set(name, value);
    }
    if (headers.get("authorization") === "Bearer service-role-test-key") {
      headers.set("authorization", `Bearer ${service}`);
    }
    const body = call.body === null
      ? undefined
      : typeof call.body === "string"
      ? call.body
      : JSON.stringify(call.body);
    const response = await h.realFetch(upstream, { method: call.method, headers, body });
    if (call.method === "GET") wire.reads.push(readOf(call, response.status, afterAuthDelete));
    return response;
  };
  return wire;
}

function readOf(call: RecordedCall, status: number, afterAuthDelete: boolean): WireRead {
  const url = new URL(call.url);
  return {
    table: url.pathname.slice("/rest/v1/".length),
    authorization: call.headers.authorization ?? "",
    apiKey: call.headers["x-pickle-api-key"],
    search: url.search,
    status,
    afterAuthDelete,
  };
}

const namespaceReads = (wire: LiveWire) =>
  wire.reads.filter((read) => NAMESPACE_TABLES.has(read.table));

// ─── #1 wire-level clean deletion ────────────────────────────────────────────

Deno.test({
  name:
    "ATTACK W08-06 r2 #1 (real PostgREST): clean deletion — every namespace is swept as the owner with the API key, the receipt is real, the identity ledger survives and re-signup inherits the spent ratings",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await hostedUid(sql);
      h.reset();
      const service = await serviceJwt();
      const owner = await seedOwner(sql, "clean");
      const hash = `encode(sha256(convert_to('google:${owner.providerId}', 'UTF8')), 'hex')`;
      await sql.unsafe(
        `insert into public.free_rating_ledger (identity_hash, scored_count) values (${hash}, 2)`,
      );
      const before = await ownerRowCounts(sql, owner.id);
      assertEquals(before.sessions, 2);
      assertEquals(before.user_saved_drills, 3);
      assertEquals(before.billing_entitlements, 1);

      const wire = liveWire(sql, service);
      const requested = await requestDeletion(owner, "198.51.100.11");
      await ageOperation(sql, requested.operationId);
      const response = await confirmDeletion(owner, requested, "198.51.100.11");
      const body = await response.json();
      assertEquals(response.status, 200, JSON.stringify(body));
      assertEquals(body.deleted, true);
      assertEquals(body.operationId, requested.operationId);
      assertEquals(typeof body.completionReceipt?.completedAt, "string");
      assertEquals(body.appleAuthorizationRevocation, "not_applicable");

      // Every namespace read went to PostgREST as the deleting user's bearer,
      // with the API-request key the restrictive policy demands, and was
      // accepted — preflight (before Auth delete) and completion (after).
      const reads = namespaceReads(wire);
      const preflight = reads.filter((read) => !read.afterAuthDelete);
      const completion = reads.filter((read) => read.afterAuthDelete);
      assertEquals(new Set(preflight.map((read) => read.table)).size, NAMESPACE_TABLES.size);
      assertEquals(new Set(completion.map((read) => read.table)).size, NAMESPACE_TABLES.size);
      for (const read of reads) {
        assertEquals(read.status, 200, `${read.table}${read.search}`);
        assertEquals(read.authorization, `Bearer ${owner.jwt}`, read.table);
        assert(
          read.apiKey && /^[0-9a-f]{64}$/.test(read.apiKey),
          `${read.table} lacks the API key`,
        );
        assertStringIncludes(read.search, `=eq.${owner.id}`);
        assertStringIncludes(read.search, "order=");
        assertStringIncludes(read.search, "limit=");
      }
      // no service-role read of any client-owned namespace
      assertEquals(
        wire.reads.filter(
          (read) => NAMESPACE_TABLES.has(read.table) && read.authorization === `Bearer ${service}`,
        ).length,
        0,
      );

      // Durable state matches the receipt; the owner's rows are gone.
      const row = await operationRow(sql, requested.operationId);
      assertEquals(row.phase, "completed");
      assertNotEquals(row.auth_deleted_at, null);
      assertEquals(row.lease_token, null);
      const after = await ownerRowCounts(sql, owner.id);
      for (const [table, count] of Object.entries(after)) assertEquals(count, 0, table);
      assertEquals(
        (await sql.unsafe(`select count(*)::int as n from auth.users where id = '${owner.id}'`))[0]
          .n,
        0,
      );

      // Free-rating conservation: the ledger row survived and a NEW account
      // signing in with the same Google identity starts at the spent count.
      const ledger = await sql.unsafe(
        `select scored_count from public.free_rating_ledger where identity_hash = ${hash}`,
      );
      assertEquals(ledger.length, 1);
      assertEquals(ledger[0].scored_count, 2);
      const reborn = crypto.randomUUID();
      await sql.unsafe(
        `insert into auth.users (id, email) values ('${reborn}', 'reborn@example.com')`,
      );
      await sql.unsafe(
        `insert into auth.identities (provider_id, user_id, provider, identity_data) values
           ('${owner.providerId}', '${reborn}', 'google', '{"sub":"${owner.providerId}"}')`,
      );
      const apiKey = (await sql.unsafe(`select public.get_api_request_key() as k`))[0].k as string;
      const inherited = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role authenticated`);
        await tx.unsafe(`set local request.jwt.claim.sub = '${reborn}'`);
        await tx.unsafe(`set local request.headers = '{"x-pickle-api-key":"${apiKey}"}'`);
        return (await tx.unsafe(`select public.identity_scored_count() as n`))[0].n;
      });
      assertEquals(inherited, 2);
      // The ledger still names no account: only the hash and the count.
      const columns = await sql.unsafe(
        `select column_name from information_schema.columns
           where table_schema = 'public' and table_name = 'free_rating_ledger' order by 1`,
      );
      assertEquals(
        columns.map((column) => column.column_name),
        ["created_at", "identity_hash", "scored_count", "updated_at"],
      );
      await sql.unsafe(`delete from auth.users where id = '${reborn}'`);
    } finally {
      h.respond = () => null;
      await sql.end();
    }
  },
});

// ─── #2 residue after Auth deletion vs the durable status ────────────────────

Deno.test({
  name:
    "ATTACK W08-06 r2 #2 (real PostgREST + real SQL state): residue found after Auth deletion withholds the confirm reply — the durable operation must not read `completed` with a receipt to /delete-status while carrying no trace of the withheld completion",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await hostedUid(sql);
      h.reset();
      const service = await serviceJwt();
      const owner = await seedOwner(sql, "residue");
      const wire = liveWire(sql, service);
      // One namespace keeps a row the cascade missed (e.g. a table whose FK
      // lost ON DELETE CASCADE in a later migration).
      wire.override = (call, { afterAuthDelete }) => {
        if (!afterAuthDelete || call.method !== "GET") return null;
        if (!new URL(call.url).pathname.endsWith("/player_rank_state")) return null;
        return Response.json([{ user_id: owner.id }], { status: 200 });
      };
      const requested = await requestDeletion(owner, "198.51.100.12");
      await ageOperation(sql, requested.operationId);
      const { result: confirm, logs } = await captureConsole(() =>
        confirmDeletion(owner, requested, "198.51.100.12")
      );
      const confirmBody = await confirm.json();
      assertEquals(confirm.status, 503, JSON.stringify(confirmBody));
      assertEquals(confirmBody.deleted, undefined);
      assertEquals(confirmBody.completionReceipt, undefined);
      const residueLog = JSON.stringify(logs);
      assertStringIncludes(residueLog, "completion_unverified");
      assertStringIncludes(residueLog, "player_rank_state");

      // The Auth identity IS gone (irreversible) …
      assertEquals(wire.authDeleted, [owner.id]);
      assertEquals(
        (await sql.unsafe(`select count(*)::int as n from auth.users where id = '${owner.id}'`))[0]
          .n,
        0,
      );
      // … and the durable row already says completed: the residue verdict the
      // worker just reached is recorded nowhere (`fail_…` needs a lease the
      // Auth-delete trigger has cleared).
      const row = await operationRow(sql, requested.operationId);
      assertEquals(row.phase, "completed");
      assertNotEquals(row.completed_at, null);
      assertEquals(row.lease_token, null);
      assertEquals(row.last_error_code, null);

      // The status capability the app polls after a 503 returns `completed`
      // with a receipt — the exact evidence the confirm reply just withheld.
      const status = await deletionStatus(requested, "198.51.100.13");
      const statusBody = await status.json();
      assertEquals(status.status, 200, JSON.stringify(statusBody));
      assertEquals(statusBody.state, "completed");
      assertEquals(typeof statusBody.completionReceipt?.completedAt, "string");

      // The owner cannot retry: the confirm bearer's session cascaded away.
      const retry = await confirmDeletion(owner, requested, "198.51.100.12");
      const retryBody = await retry.text();
      assertNotEquals(retry.status, 200, retryBody);
      assertEquals(retry.status, 401, retryBody);

      // BREAK (P1): the worker refused to certify this deletion (503, no
      // receipt, residue logged) — the durable record the app polls must not
      // say `completed` with no trace of that refusal.
      assert(
        row.last_error_code === "completion_unverified" || statusBody.state !== "completed",
        `worker withheld completion (residue in player_rank_state) but durable phase=${row.phase} last_error_code=${row.last_error_code} and /delete-status state=${statusBody.state} with a receipt`,
      );
    } finally {
      h.respond = () => null;
      await sql.end();
    }
  },
});

// ─── #3 sweep transport failure after Auth deletion ──────────────────────────

Deno.test({
  name:
    "ATTACK W08-06 r2 #3 (real PostgREST): steady 429 + Retry-After on one namespace after Auth deletion — exactly INVENTORY_READ_ATTEMPTS wire reads with no wait, confirm 503 without upstream detail, durable status still `completed`",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await hostedUid(sql);
      h.reset();
      const service = await serviceJwt();
      const owner = await seedOwner(sql, "outage");
      const wire = liveWire(sql, service);
      let failures = 0;
      wire.override = (call, { afterAuthDelete }) => {
        if (!afterAuthDelete || call.method !== "GET") return null;
        if (!new URL(call.url).pathname.endsWith("/sessions")) return null;
        failures += 1;
        return Response.json(
          { message: "FAKE-rate-limited" },
          { status: 429, headers: { "Retry-After": "30" } },
        );
      };
      const requested = await requestDeletion(owner, "198.51.100.14");
      await ageOperation(sql, requested.operationId);
      const startedAt = Date.now();
      const confirm = await confirmDeletion(owner, requested, "198.51.100.14");
      const elapsedMs = Date.now() - startedAt;
      const body = await confirm.text();
      assertEquals(confirm.status, 503, body);
      assert(!body.includes("FAKE-"), "upstream detail leaked to the caller");
      assertEquals(failures, INVENTORY_READ_ATTEMPTS);
      assertEquals(
        namespaceReads(wire).filter((read) => read.table === "sessions" && read.afterAuthDelete)
          .length,
        INVENTORY_READ_ATTEMPTS,
      );
      // Retry-After: 30 was ignored (no wait between attempts).
      assert(elapsedMs < 5_000, `sweep waited ${elapsedMs} ms`);

      const row = await operationRow(sql, requested.operationId);
      assertEquals(row.phase, "completed");
      assertEquals(row.last_error_code, null);
      const status = await deletionStatus(requested, "198.51.100.15");
      assertEquals(status.status, 200);
      assertEquals((await status.json()).state, "completed");
    } finally {
      h.respond = () => null;
      await sql.end();
    }
  },
});

// ─── #3b the SDK's hidden 503 retry multiplies the worker's budget ───────────

/** postgrest-js 2.112.4 retries idempotent GETs on 503/520 itself
 * (DEFAULT_MAX_RETRIES = 3, backoff 1 s / 2 s / 4 s unless the reply carries
 * Retry-After) — underneath the worker's own INVENTORY_READ_ATTEMPTS loop and
 * inside the 10 s abort the route puts on each page. */
Deno.test({
  name:
    "ATTACK W08-06 r2 #3b (real PostgREST): steady 503 on one namespace after Auth deletion — the sweep must stay within INVENTORY_READ_ATTEMPTS wire reads and answer the confirm inside the app's 15 s request timeout",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await hostedUid(sql);
      h.reset();
      const service = await serviceJwt();
      const owner = await seedOwner(sql, "outage503");
      const wire = liveWire(sql, service);
      const readAt: number[] = [];
      wire.override = (call, { afterAuthDelete }) => {
        if (!afterAuthDelete || call.method !== "GET") return null;
        if (!new URL(call.url).pathname.endsWith("/sessions")) return null;
        readAt.push(Date.now());
        return Response.json({ message: "FAKE-gateway-unavailable" }, { status: 503 });
      };
      const requested = await requestDeletion(owner, "198.51.100.24");
      await ageOperation(sql, requested.operationId);
      const startedAt = Date.now();
      const confirm = await confirmDeletion(owner, requested, "198.51.100.24");
      const elapsedMs = Date.now() - startedAt;
      const body = await confirm.text();
      assertEquals(confirm.status, 503, body);
      assert(!body.includes("FAKE-"), "upstream detail leaked to the caller");
      const row = await operationRow(sql, requested.operationId);
      assertEquals(row.phase, "completed");
      assertEquals(row.last_error_code, null);
      const status = await deletionStatus(requested, "198.51.100.25");
      assertEquals(status.status, 200);
      assertEquals((await status.json()).state, "completed");

      // BREAK (P2): the worker's declared budget is INVENTORY_READ_ATTEMPTS
      // reads per namespace, and the mobile transport
      // (deletionOperationTransport.ts) gives the confirm request 15 s (30 s at
      // most). Under a steady 503 the SDK retries each read 3 more times with
      // 1 + 2 + 4 s backoff, so the confirm is held past the app's deadline.
      const MOBILE_CONFIRM_TIMEOUT_MS = 15_000;
      assert(
        readAt.length === INVENTORY_READ_ATTEMPTS && elapsedMs <= MOBILE_CONFIRM_TIMEOUT_MS,
        `one namespace answering 503 cost ${readAt.length} wire reads (budget ${INVENTORY_READ_ATTEMPTS}) and held the confirm reply ${elapsedMs} ms (app deadline ${MOBILE_CONFIRM_TIMEOUT_MS} ms)`,
      );
    } finally {
      h.respond = () => null;
      await sql.end();
    }
  },
});

// ─── #4 paged residue through real PostgREST (max_rows = 1000) ───────────────

Deno.test({
  name:
    "ATTACK W08-06 r2 #4 (real PostgREST): 1 500 leftover rows are paged with the candidate's keyset `or=(…)` filter through real PostgREST — three pages, no repeat, residue withheld",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await hostedUid(sql);
      h.reset();
      const service = await serviceJwt();
      const owner = await seedOwner(sql, "paged", 0);
      // A still-existing account whose 1 500 drills stand in for rows the
      // cascade left behind: after Auth deletion the owner's drill reads are
      // answered by PostgREST for the ghost (same bearer shape, same filter
      // shape) and re-labelled with the owner id so only PAGINATION is tested.
      const ghost = await seedOwner(sql, "ghost", 1_500);
      const wire = liveWire(sql, service);
      const ghostPages: string[] = [];
      wire.override = (call, { afterAuthDelete }) => {
        if (!afterAuthDelete || call.method !== "GET") return null;
        const url = new URL(call.url);
        if (!url.pathname.endsWith("/user_saved_drills")) return null;
        ghostPages.push(url.search);
        return null;
      };
      const proxied = h.respond;
      h.respond = async (call) => {
        const url = new URL(call.url);
        if (
          wire.authDeleted.length > 0 &&
          call.method === "GET" &&
          url.pathname.endsWith("/user_saved_drills")
        ) {
          const rewritten = new URL(call.url);
          rewritten.searchParams.set("user_id", `eq.${ghost.id}`);
          const response = await proxied({
            ...call,
            url: rewritten.toString(),
            headers: { ...call.headers, authorization: `Bearer ${ghost.jwt}` },
          });
          const text = (await response!.text()).replaceAll(ghost.id, owner.id);
          return new Response(text, { status: response!.status, headers: response!.headers });
        }
        return proxied(call);
      };
      const requested = await requestDeletion(owner, "198.51.100.16");
      await ageOperation(sql, requested.operationId);
      const { result: confirm, logs } = await captureConsole(() =>
        confirmDeletion(owner, requested, "198.51.100.16")
      );
      assertEquals(confirm.status, 503, await confirm.text());
      assertEquals(ghostPages.length, 3, JSON.stringify(ghostPages));
      assert(!ghostPages[0].includes("or="), ghostPages[0]);
      assertStringIncludes(decodeURIComponent(ghostPages[1]), 'or=(slug.lt."drill-00501")');
      assertStringIncludes(decodeURIComponent(ghostPages[2]), 'or=(slug.lt."drill-00001")');
      for (const page of ghostPages) {
        assertStringIncludes(page, "order=slug.desc");
        assertStringIncludes(page, "limit=1000");
      }
      const detail = JSON.stringify(logs);
      assertStringIncludes(detail, "user_saved_drills");
      assertStringIncludes(detail, '"rows":1500');
      assertStringIncludes(detail, '"pages":3');
      await sql.unsafe(`delete from auth.users where id = '${ghost.id}'`);
    } finally {
      h.respond = () => null;
      await sql.end();
    }
  },
});

// ─── #5 unauthorised actors on the sweep surface (allowed AND denied) ────────

Deno.test({
  name:
    "ATTACK W08-06 r2 #5 (real PostgREST RLS): another user, a bearer without the API key, anon and the service role — RLS answers an EMPTY page (not an error) for the first two, so the sweep is only sound as the owner's own API-keyed bearer",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await hostedUid(sql);
      const owner = await seedOwner(sql, "rls");
      const other = await seedOwner(sql, "other");
      const service = await serviceJwt();
      const apiKey = (await sql.unsafe(`select public.get_api_request_key() as k`))[0].k as string;
      const page = (table: string, bearer: string | null, key: string | null) =>
        h.realFetch(
          `${PGRST_URL}/${table}?select=user_id&user_id=eq.${owner.id}&order=user_id.desc&limit=1000`,
          {
            headers: {
              ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
              ...(key ? { "x-pickle-api-key": key } : {}),
            },
          },
        );
      const asJson = async (response: Response) => ({
        status: response.status,
        body: (await response.text()).slice(0, 200),
      });

      // allowed: the owner with the API key sees the rows
      const own = await asJson(await page("sessions", owner.jwt, apiKey));
      assertEquals(own.status, 200);
      assertEquals(JSON.parse(own.body).length, 2);

      // RLS-empty, not denied: another user's bearer
      const cross = await asJson(await page("sessions", other.jwt, apiKey));
      assertEquals(cross.status, 200);
      assertEquals(cross.body, "[]");
      // RLS-empty, not denied: the owner without the API-request key
      const keyless = await asJson(await page("sessions", owner.jwt, null));
      assertEquals(keyless.status, 200);
      assertEquals(keyless.body, "[]");
      // denied: anon and the service role on a client-owned namespace
      const anon = await asJson(await page("sessions", null, apiKey));
      assert(anon.status === 401 || anon.status === 403, JSON.stringify(anon));
      const serviceDenied = await asJson(await page("sessions", service, apiKey));
      assertEquals(serviceDenied.status, 403, JSON.stringify(serviceDenied));
      assertStringIncludes(serviceDenied.body, "42501");
      // allowed: the service role on billing_entitlements (its one grant)
      const serviceAllowed = await asJson(await page("billing_entitlements", service, apiKey));
      assertEquals(serviceAllowed.status, 200, JSON.stringify(serviceAllowed));
      assertEquals(JSON.parse(serviceAllowed.body).length, 1);

      await sql.unsafe(`delete from auth.users where id in ('${owner.id}', '${other.id}')`);
    } finally {
      await sql.end();
    }
  },
});

// ─── #6 hostile text keys inside the compound keyset cursor ──────────────────

/** `shot_phases.phase_key` is client-written through `apply_synced_shot` and
 * bounded only by length (64), so a page boundary can land on a key holding
 * every character PostgREST's logic-tree parser treats specially. */
Deno.test({
  name:
    "ATTACK W08-06 r2 #6 (real PostgREST): 1 003 shot_phases rows whose phase_key holds quotes, backslashes, commas, parentheses, %, & and non-ASCII — the compound `or=(shot_id.lt.…,and(shot_id.eq.…,phase_key.lt.…))` cursor still pages every row, no repeat, residue withheld",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await hostedUid(sql);
      h.reset();
      const service = await serviceJwt();
      const owner = await seedOwner(sql, "hostile", 0);
      const ghost = await seedOwner(sql, "hostileghost", 0);
      const shot = crypto.randomUUID();
      await sql.unsafe(
        `insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms,
           analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
           paddle_model_version, stroke_detector_version, phase_model_version,
           scoring_model_version, shot_config_version)
         values ('${shot}', '${ghost.id}', 'dink', now(), 0, 1000, 0.5, 'partial',
           'w0806', 'w0806', 'w0806', 'w0806', 'w0806', 'w0806', 'w0806', 'w0806')`,
      );
      const ROWS = 1_003;
      const phases = Array.from({ length: ROWS }, (_, index) => ({
        shot_id: shot,
        user_id: ghost.id,
        phase_key: `p${String(index).padStart(4, "0")} "q\\"" \\b ,c (d) %e &f +g é:h*i;j\n\tk`,
        start_ms: index,
        representative_ms: index,
        end_ms: index + 1,
        confidence: 0.5,
      }));
      for (let offset = 0; offset < phases.length; offset += 250) {
        await sql`insert into public.shot_phases ${sql(phases.slice(offset, offset + 250))}`;
      }
      const boundary = await sql.unsafe(
        `select phase_key from public.shot_phases where shot_id = '${shot}'
           order by shot_id desc, phase_key desc offset 999 limit 1`,
      );
      const boundaryKey = boundary[0].phase_key as string;

      const wire = liveWire(sql, service);
      const ghostPages: string[] = [];
      const proxied = h.respond;
      h.respond = async (call) => {
        const url = new URL(call.url);
        if (
          wire.authDeleted.length > 0 &&
          call.method === "GET" &&
          url.pathname.endsWith("/shot_phases")
        ) {
          ghostPages.push(url.search);
          const rewritten = new URL(call.url);
          rewritten.searchParams.set("user_id", `eq.${ghost.id}`);
          const response = await proxied({
            ...call,
            url: rewritten.toString(),
            headers: { ...call.headers, authorization: `Bearer ${ghost.jwt}` },
          });
          const text = (await response!.text()).replaceAll(ghost.id, owner.id);
          return new Response(text, { status: response!.status, headers: response!.headers });
        }
        return proxied(call);
      };
      const requested = await requestDeletion(owner, "198.51.100.26");
      await ageOperation(sql, requested.operationId);
      const { result: confirm, logs } = await captureConsole(() =>
        confirmDeletion(owner, requested, "198.51.100.26")
      );
      assertEquals(confirm.status, 503, await confirm.text());
      const detail = JSON.stringify(logs);
      assertStringIncludes(detail, '"table":"shot_phases"');
      // every row was inventoried through the escaped cursor: not `unread`
      assertStringIncludes(detail, '"outcome":"residue"');
      assertStringIncludes(detail, `"rows":${ROWS}`);
      assertStringIncludes(detail, '"pages":3');
      assertEquals(ghostPages.length, 3, JSON.stringify(ghostPages));
      assert(!ghostPages[0].includes("or="), ghostPages[0]);
      const secondPage = new URLSearchParams(ghostPages[1]).get("or") ?? "";
      assertEquals(
        secondPage,
        `(shot_id.lt."${shot}",and(shot_id.eq."${shot}",phase_key.lt.${
          postgrestFilterValue(boundaryKey)
        }))`,
      );
      for (const page of ghostPages) {
        assertStringIncludes(page, "order=shot_id.desc%2Cphase_key.desc");
        assertStringIncludes(page, "limit=1000");
      }
      await sql.unsafe(`delete from auth.users where id = '${ghost.id}'`);
    } finally {
      h.respond = () => null;
      await sql.end();
    }
  },
});

// ─── #7 double submit: two concurrent confirms of the same challenge ─────────

Deno.test({
  name:
    "ATTACK W08-06 r2 #7 (real PostgREST + real SQL lease): the same confirm submitted twice concurrently performs Apple/RevenueCat/Auth deletion once, hands out one receipt, and the loser gets a non-success reply that never fabricates a second deletion",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await hostedUid(sql);
      h.reset();
      const service = await serviceJwt();
      const owner = await seedOwner(sql, "double");
      const wire = liveWire(sql, service);
      const requested = await requestDeletion(owner, "198.51.100.27");
      await ageOperation(sql, requested.operationId);
      const replies = await Promise.all([
        confirmDeletion(owner, requested, "198.51.100.27"),
        confirmDeletion(owner, requested, "198.51.100.27"),
      ]);
      const bodies = await Promise.all(replies.map((reply) => reply.json()));
      const statuses = replies.map((reply) => reply.status);
      // exactly one irreversible pass over the external systems
      assertEquals(wire.authDeleted, [owner.id], JSON.stringify({ statuses, bodies }));
      assertEquals(
        h.callsTo(RC_URL).filter((call) => call.method === "DELETE").length,
        1,
        "RevenueCat customer deleted more than once",
      );
      const receipts = bodies.filter((body) => body.deleted === true);
      assert(receipts.length >= 1, JSON.stringify({ statuses, bodies }));
      for (const body of receipts) {
        assertEquals(body.operationId, requested.operationId);
        assertEquals(typeof body.completionReceipt?.completedAt, "string");
      }
      // the other reply is 200 (same receipt), 202 in_progress or 409 — never
      // a 5xx and never `deleted:true` for a different operation
      for (const [index, status] of statuses.entries()) {
        assert([200, 202, 409].includes(status), JSON.stringify({ statuses, bodies }));
        if (status !== 200) assertEquals(bodies[index].deleted, undefined);
      }
      const row = await operationRow(sql, requested.operationId);
      assertEquals(row.phase, "completed");
      assertEquals(row.lease_token, null);
      const after = await ownerRowCounts(sql, owner.id);
      for (const [table, count] of Object.entries(after)) assertEquals(count, 0, table);
    } finally {
      h.respond = () => null;
      await sql.end();
    }
  },
});

// ─── #8 redirect during the pre-flight probe, then recovery ──────────────────

Deno.test({
  name:
    "ATTACK W08-06 r2 #8 (real PostgREST): a 302 on one pre-flight probe is not followed, nothing irreversible runs, the lease is released with completion_unverified, and the SAME bearer completes the deletion once the redirect stops",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await hostedUid(sql);
      h.reset();
      const service = await serviceJwt();
      const owner = await seedOwner(sql, "redirect");
      const wire = liveWire(sql, service);
      let redirecting = true;
      wire.override = (call) => {
        if (!redirecting || call.method !== "GET") return null;
        if (!new URL(call.url).pathname.endsWith("/consent_records")) return null;
        return new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example/rest/v1/consent_records" },
        });
      };
      const requested = await requestDeletion(owner, "198.51.100.28");
      await ageOperation(sql, requested.operationId);
      const { result: first, logs } = await captureConsole(() =>
        confirmDeletion(owner, requested, "198.51.100.28")
      );
      assertEquals(first.status, 503, await first.text());
      assertStringIncludes(JSON.stringify(logs), '"stage":"preflight"');
      assertEquals(h.callsTo("evil.example").length, 0, "redirect was followed");
      assertEquals(wire.authDeleted, []);
      assertEquals(h.callsTo(RC_URL).filter((call) => call.method === "DELETE").length, 0);
      assertEquals(h.callsTo("appleid.apple.com").length, 0);
      const parked = await operationRow(sql, requested.operationId);
      assertNotEquals(parked.phase, "completed");
      assertEquals(parked.lease_token, null, "lease still held after the pre-flight failure");
      assertEquals(parked.last_error_code, "completion_unverified");
      assertEquals(parked.auth_deleted_at, null);
      const intact = await ownerRowCounts(sql, owner.id);
      assertEquals(intact.sessions, 2);
      assertEquals(intact.consent_records, 0);

      // recovery: the bearer is still valid (nothing was destroyed)
      redirecting = false;
      const second = await confirmDeletion(owner, requested, "198.51.100.28");
      const body = await second.json();
      assertEquals(second.status, 200, JSON.stringify(body));
      assertEquals(body.deleted, true);
      assertEquals(body.operationId, requested.operationId);
      assertEquals(wire.authDeleted, [owner.id]);
      const done = await operationRow(sql, requested.operationId);
      assertEquals(done.phase, "completed");
      assertEquals(done.attempts, 2);
    } finally {
      h.respond = () => null;
      await sql.end();
    }
  },
});

// ─── #9 retention disclosure parity across every `retained` table ────────────

Deno.test(
  "ATTACK W08-06 r2 #9 (copy): every table the candidate labels `retained` has its post-deletion retention disclosed in Privacy §7, and the in-app confirmation, support page and Terms agree on the free-rating outcome without prohibited terms",
  async () => {
    const flat = (text: string) => text.replace(/\s+/g, " ");
    const privacy = flat(PRIVACY_POLICY_TEXT);
    const support = flat(SUPPORT_TEXT);
    const terms = flat(TERMS_TEXT);
    const section7 = privacy.slice(
      privacy.indexOf("7. RETENTION"),
      privacy.indexOf("8. ACCOUNT DELETION"),
    );
    assert(section7.length > 0, "Privacy §7 not found");
    const inApp = flat(
      await Deno.readTextFile(
        new URL("../../../../apps/mobile/src/screens/ManageAccountScreen.tsx", import.meta.url),
      ),
    );

    // free-rating outcome: the three surfaces say the same thing
    assertStringIncludes(inApp, "Free ratings you've already used stay used");
    assertStringIncludes(inApp, "same Apple or Google sign-in won't get them again");
    assertStringIncludes(support, "does not restore free ratings that were already used");
    assertStringIncludes(
      terms,
      "free ratings already used are not restored by deleting the account",
    );
    assertStringIncludes(section7, "survives account deletion");
    for (const text of [inApp, support, terms, privacy]) {
      for (
        const banned of [
          "Android",
          "Google Play",
          "guest mode",
          "Live Court",
          "DUPR",
          "SwingVision",
          "PB Vision",
          "% accura",
        ]
      ) {
        assert(!text.includes(banned), banned);
      }
    }

    // BREAK (P3): each `retained` table needs a §7 statement of WHAT survives
    // deletion and for HOW LONG. free_rating_ledger → hash + count (indefinite);
    // webhook_events → 90 days; api_private.account_deletion_operations keeps
    // owner_id, the Apple outcome and timestamps for `retain_until = created_at
    // + 7 days` (20260907001500_account_deletion_operations.sql) after the
    // account is gone — §7 only speaks of a 15-minute challenge.
    const retained = Object.entries(ACCOUNT_DELETION_UNREAD_TABLES)
      .filter(([, reason]) => reason === "retained")
      .map(([table]) => table);
    assertEquals(retained.length, 3);
    const disclosed: Record<string, RegExp> = {
      free_rating_ledger: /one-way hash \(SHA-256\)[^.]*sign-in provider's account identifier/,
      webhook_events: /webhook audit records are scheduled for deletion after 90 days/,
      "api_private.account_deletion_operations":
        /deletion (record|operation|receipt)[^.]*(7|seven) days/i,
    };
    for (const table of retained) {
      assert(
        disclosed[table].test(section7),
        `Privacy §7 does not disclose the post-deletion retention of ${table}`,
      );
    }
  },
);
