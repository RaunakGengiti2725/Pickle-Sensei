// Adversarial pass 3 (db-schema-migrations, tester #2) — EDGE half of S5.
//
// The Edge Function's `POST /v1/me/delete-confirm` is exercised in-process
// against a fake GoTrue, while the PostgREST read of
// `public.account_deletion_requests` is answered from the REAL throwaway
// Postgres (all migrations applied) under RLS as the calling user — so the
// 403 `account.deletion_challenge_expired` decision is made on a row that
// really lives in the table, including one that expired 2 days ago and has
// NOT yet been swept by the pg_cron purge (`expires_at < now() - 1 day`).
//
// Run (repo root; DB test skips itself when PICKLE_AUDIT_PG_URL is unset —
// a skipped stage is NOT a pass):
//   PICKLE_AUDIT_PG_URL=postgres://postgres:pg@127.0.0.1:55432/postgres \
//     deno test -A --no-check --config supabase/functions/api/__wf__/deno.json \
//       supabase/functions/api/__wf__/attack_db_schema_migrations_2_edge.test.ts
//
// `--no-check` because index.ts carries the pre-existing untyped-supabase-
// client errors documented in AGENTS.md.

import postgres from "postgres";
import { assertEquals } from "@std/assert";

const PG_URL = Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const ARTIFACT_DIR = Deno.env.get("ATTACK_ARTIFACT_DIR") ?? "";

type Row = Record<string, unknown>;
const journal: Row[] = [];
async function record(entry: Row) {
  journal.push(entry);
  if (ARTIFACT_DIR) {
    await Deno.mkdir(ARTIFACT_DIR, { recursive: true });
    await Deno.writeTextFile(
      `${ARTIFACT_DIR}/summary_edge.json`,
      JSON.stringify(journal, null, 2),
    );
  }
}

// ─── Fake Supabase: GoTrue is faked, PostgREST reads go to the real DB ───────

const state = { adminDeleteCalls: 0, restReads: [] as Row[] };

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const b64url = (input: string): string =>
  btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function providerToken(sub: string): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub,
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    }),
  );
  return `${header}.${payload}.sig`;
}

/** Answer a PostgREST `GET /rest/v1/account_deletion_requests?user_id=eq.<id>`
 * from the real table, as that user, under RLS (role authenticated + jwt sub). */
async function readDeletionRequestsAs(userId: string): Promise<Row[]> {
  if (!PG_URL) return [];
  const c = postgres(PG_URL, { max: 1 });
  try {
    await c.unsafe(`begin`);
    await c.unsafe(`set local role authenticated`);
    await c.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [
      userId,
    ]);
    await c.unsafe(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    const rows = await c.unsafe(
      `select challenge, created_at, expires_at from public.account_deletion_requests where user_id = $1`,
      [userId],
    );
    await c.unsafe(`rollback`);
    return rows.map((r) => ({
      challenge: String(r.challenge),
      created_at: new Date(r.created_at as string).toISOString(),
      expires_at: new Date(r.expires_at as string).toISOString(),
    }));
  } finally {
    await c.end();
  }
}

async function fakeSupabase(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "POST" && path === "/auth/v1/token") {
    const body = (await request.json()) as { id_token: string };
    const claims = JSON.parse(
      atob(body.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    ) as {
      sub: string;
    };
    return jsonResponse(200, {
      access_token: `sb-access-${claims.sub}`,
      token_type: "bearer",
      expires_in: 3_600,
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      refresh_token: `sb-refresh-${claims.sub}`,
      user: {
        id: claims.sub,
        aud: "authenticated",
        role: "authenticated",
        email: "u@example.com",
      },
    });
  }
  if (request.method === "DELETE" && path.startsWith("/auth/v1/admin/users/")) {
    state.adminDeleteCalls += 1;
    return jsonResponse(200, {});
  }
  if (
    path === "/rest/v1/account_deletion_requests" && request.method === "GET"
  ) {
    const eq = url.searchParams.get("user_id") ?? "";
    const userId = eq.startsWith("eq.") ? eq.slice(3) : "";
    const rows = await readDeletionRequestsAs(userId);
    state.restReads.push({ userId, rows: rows.length });
    return jsonResponse(200, rows);
  }
  if (
    path === "/rest/v1/account_external_credentials" && request.method === "GET"
  ) return jsonResponse(200, []);
  return jsonResponse(404, {
    message: `fake supabase: unhandled ${request.method} ${path}`,
  });
}

const fake = Deno.serve({ port: 0, onListen: () => undefined }, fakeSupabase);
const fakeUrl = `http://127.0.0.1:${fake.addr.port}`;
Deno.env.set("SUPABASE_URL", fakeUrl);
Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_revenuecat");

type Handler = (request: Request) => Promise<Response> | Response;
let handler: Handler | null = null;
const realServe = Deno.serve;
(Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
  handler = (typeof args[0] === "function" ? args[0] : args[1]) as Handler;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
};
await import("../index.ts");
(Deno as unknown as { serve: unknown }).serve = realServe;
if (!handler) throw new Error("index.ts did not register a Deno.serve handler");
const api: Handler = handler;

const call = (
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<Response> =>
  Promise.resolve(
    api(
      new Request(`http://edge.local/functions/v1/api${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-forwarded-for": "203.0.113.9",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  );

async function provision(admin: ReturnType<typeof postgres>, id: string) {
  await admin.unsafe(
    `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
     values ($1, $2, '{}'::jsonb, '{"provider":"google","providers":["google"]}'::jsonb)`,
    [id, `${id}@example.com`],
  );
}

async function insertRequestAsOwner(
  userId: string,
  challenge: string,
  createdAgo: string,
  expiresAgo: string,
) {
  const c = postgres(PG_URL, { max: 1 });
  try {
    await c.unsafe(`begin`);
    await c.unsafe(`set local role authenticated`);
    await c.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [
      userId,
    ]);
    await c.unsafe(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await c.unsafe(
      `insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
       values ($1, $2, now() - $3::interval, now() - $4::interval)`,
      [userId, challenge, createdAgo, expiresAgo],
    );
    await c.unsafe(`commit`);
  } finally {
    await c.end();
  }
}

Deno.test({
  name:
    "S5 edge: fresh challenge whose expires_at is already past → 403 account.deletion_challenge_expired, no admin delete",
  ignore,
  async fn() {
    const admin = postgres(PG_URL, { max: 1 });
    const u = crypto.randomUUID();
    const detail: Row = { user: u };
    try {
      await provision(admin, u);
      const challenge = crypto.randomUUID();
      // created 20s ago (past the 3s too-fast floor), expired 1s ago
      await insertRequestAsOwner(u, challenge, "20 seconds", "1 second");
      const res = await call(
        "POST",
        "/v1/me/delete-confirm",
        providerToken(u),
        { challenge },
      );
      const body = (await res.json()) as { error?: { code?: string } };
      detail.status = res.status;
      detail.code = body.error?.code;
      detail.adminDeleteCalls = state.adminDeleteCalls;
      detail.restReads = state.restReads;
      await record({ scenario: "S5 edge expired challenge", ...detail });
      assertEquals(res.status, 403);
      assertEquals(body.error?.code, "account.deletion_challenge_expired");
      assertEquals(state.adminDeleteCalls, 0);
      // The RLS read really saw the row (1), so the decision was made on it.
      assertEquals(state.restReads.at(-1)?.rows, 1);
    } finally {
      await admin.unsafe(`delete from auth.users where id = $1`, [u]).catch(
        () => undefined,
      );
      await admin.end();
    }
  },
});

Deno.test({
  name:
    "S5 edge: 2-day-expired row (not yet cron-purged) is still owner-readable through RLS and still yields 403 expired, never 'invalid'",
  ignore,
  async fn() {
    const admin = postgres(PG_URL, { max: 1 });
    const u = crypto.randomUUID();
    const detail: Row = { user: u };
    try {
      await provision(admin, u);
      const challenge = crypto.randomUUID();
      await insertRequestAsOwner(u, challenge, "2 days 15 minutes", "2 days");
      const before = state.adminDeleteCalls;
      const res = await call(
        "POST",
        "/v1/me/delete-confirm",
        providerToken(u),
        { challenge },
      );
      const body = (await res.json()) as { error?: { code?: string } };
      detail.status = res.status;
      detail.code = body.error?.code;
      detail.rowsSeenUnderRls = state.restReads.at(-1)?.rows;
      // wrong challenge against the same stale row → invalid (403), not expired
      const wrong = await call(
        "POST",
        "/v1/me/delete-confirm",
        providerToken(u),
        { challenge: crypto.randomUUID() },
      );
      const wrongBody = (await wrong.json()) as { error?: { code?: string } };
      detail.wrongChallenge = {
        status: wrong.status,
        code: wrongBody.error?.code,
      };
      // apply the cron predicate by hand → the row is gone → 'invalid'
      await admin.unsafe(
        `delete from public.account_deletion_requests where expires_at < now() - interval '1 day'`,
      );
      const afterPurge = await call(
        "POST",
        "/v1/me/delete-confirm",
        providerToken(u),
        { challenge },
      );
      const afterBody = (await afterPurge.json()) as {
        error?: { code?: string };
      };
      detail.afterPurge = {
        status: afterPurge.status,
        code: afterBody.error?.code,
        rowsSeen: state.restReads.at(-1)?.rows,
      };
      detail.adminDeleteCallsDelta = state.adminDeleteCalls - before;
      await record({ scenario: "S5 edge 2-day-old row", ...detail });
      assertEquals(
        detail.rowsSeenUnderRls,
        1,
        "2-day-expired row must still be visible to its owner before the purge",
      );
      assertEquals(res.status, 403);
      assertEquals(body.error?.code, "account.deletion_challenge_expired");
      assertEquals(wrong.status, 403);
      assertEquals(wrongBody.error?.code, "account.deletion_challenge_invalid");
      assertEquals(afterPurge.status, 403);
      assertEquals(afterBody.error?.code, "account.deletion_challenge_invalid");
      assertEquals(detail.afterPurge && (detail.afterPurge as Row).rowsSeen, 0);
      assertEquals(state.adminDeleteCalls - before, 0);
    } finally {
      await admin.unsafe(`delete from auth.users where id = $1`, [u]).catch(
        () => undefined,
      );
      await admin.end();
    }
  },
});
