// stress fuzz-boundary — POST /v1/analysis-permits, POSTGRES-BACKED half.
//
// stress_analysis_permits_fuzz.test.ts proves the handler's contract over the
// MODELLED database. This file runs the REAL edge handler (../index.ts,
// Deno.serve captured) with Supabase Auth + RevenueCat stubbed at the fetch
// layer, and PostgREST calls FORWARDED to a real PostgREST in front of the
// disposable postgres:16 that ./xc_pg_up.sh built (every migration applied) —
// so reserve_analysis_permit(text) and access_state() are the real functions
// under real RLS/grants, and every row the route writes is a real row.
//
//   ./xc_pg_up.sh                        # prints XC_PG_URL
//   ./stress_postgrest_up.sh             # prints STRESS_POSTGREST_URL + STRESS_PG_JWT_SECRET
//   XC_PG_URL=… STRESS_POSTGREST_URL=… STRESS_PG_JWT_SECRET=… \
//     STRESS_PG_ITER=1000 deno test -A --no-check --config deno.json stress_analysis_permits_pg.test.ts
//
// Without all three env vars every test is `ignore`d — an ignored run is NOT
// a pass. Seeded (STRESS_SEED): every user id, key and burst is replayable.
//
// Invariants (P0 where marked):
//   - only 200/402/429 for well-formed reserves; only 400/401/…/429 for bad input
//   - P0 idempotency: the same key from the same user (sequential OR N
//     concurrent requests through the handler) → the same permit id, ONE row
//   - P0 free-rating double-spend: a free account never holds > 2 reserved
//     permits, however many distinct keys race through the handler
//   - no analysis_permits/shots/free_rating_ledger row on any non-200
//   - every response carries x-request-id; 5xx bodies are the generic text
//
// Report: <STRESS_OUT_DIR>/analysis_permits_pg.json (seed → outcome table).

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import {
  b64url,
  envInt,
  histogram,
  isRecord,
  Prng,
} from "./xc_concurrency_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const POSTGREST_URL = (Deno.env.get("STRESS_POSTGREST_URL") ?? "").replace(
  /\/+$/,
  "",
);
const JWT_SECRET = Deno.env.get("STRESS_PG_JWT_SECRET") ?? "";
const ignore = PG_URL === "" || POSTGREST_URL === "" || JWT_SECRET === "";

const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_PG_ITER = envInt("STRESS_PG_ITER", 300);
const STRESS_PG_USERS = envInt("STRESS_PG_USERS", 60);
const STRESS_PG_LANES = envInt("STRESS_PG_LANES", 16);
const STRESS_PG_BURSTS = envInt("STRESS_PG_BURSTS", 6);

const SUPABASE_URL = "http://supabase.stress-pg.test";
const ANON_KEY = "stress-anon-key";
const SERVICE_ROLE_KEY = "stress-service-role-key";
const BASE = "http://edge.stress-pg.test/functions/v1/api";
const ROUTE = "/v1/analysis-permits";
const BAD_INPUT_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 429]);
const GENERIC_5XX = [
  /^\{"error":\{"message":"[A-Za-z ]+ is temporarily unavailable\. Please try again\."\}\}$/,
  /^\{"error":\{"message":"Something went wrong\. Please try again\."\}\}$/,
];
const LEAK_MARKERS = [
  /\n\s+at\s/,
  /\.ts:\d+/,
  /PGRST\d+/,
  /\b\d{2}[0-9A-Z]{3}\b.*(sql|postgres)/i,
  /\bpostgres\b/i,
  /\bsupabase\b/i,
];

type Sql = ReturnType<typeof postgres>;

function stressOutDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress/route-post-v1-analysis-permits/",
    import.meta.url,
  )
    .pathname;
}

// ── JWTs PostgREST will accept (HS256 over the disposable secret) ────────────

let hmacKey: CryptoKey | null = null;
async function signJwt(payload: Record<string, unknown>): Promise<string> {
  hmacKey ??= await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      hmacKey,
      new TextEncoder().encode(`${head}.${body}`),
    ),
  );
  return `${head}.${body}.${b64url(String.fromCharCode(...sig))}`;
}

interface User {
  index: number;
  id: string;
  email: string;
  accessToken: string;
  premium: boolean;
  ip: string;
}

// ── Real handler, PostgREST forwarded, Auth/RevenueCat stubbed ───────────────

interface PgEdgeHarness {
  handler: (request: Request) => Promise<Response>;
  sessions: Map<string, User>;
  upstream: { auth: number; rest: number; rc: number; other: string[] };
}

let loaded: PgEdgeHarness | null = null;

async function loadPgEdgeHarness(): Promise<PgEdgeHarness> {
  if (loaded) return loaded;
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const realFetch = globalThis.fetch;
  const sessions = new Map<string, User>();
  const upstream: PgEdgeHarness["upstream"] = {
    auth: 0,
    rest: 0,
    rc: 0,
    other: [],
  };

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin === SUPABASE_URL && url.pathname === "/auth/v1/user" &&
      request.method === "GET"
    ) {
      upstream.auth += 1;
      const auth = request.headers.get("authorization") ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const user = sessions.get(bearer);
      if (!user) {
        return Response.json(
          {
            code: 403,
            error_code: "session_not_found",
            msg: "Session from session_id claim in JWT does not exist",
          },
          { status: 403 },
        );
      }
      return Response.json({
        id: user.id,
        aud: "authenticated",
        role: "authenticated",
        email: user.email,
        app_metadata: { provider: "google", providers: ["google"] },
        user_metadata: {},
        identities: [],
        created_at: "2026-09-01T00:00:00Z",
      });
    }
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
      upstream.rest += 1;
      const forwarded = new Headers(request.headers);
      forwarded.delete("host");
      const body = request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
      return realFetch(
        `${POSTGREST_URL}${url.pathname.slice("/rest/v1".length)}${url.search}`,
        {
          method: request.method,
          headers: forwarded,
          body,
        },
      );
    }
    if (url.hostname === "api.revenuecat.com") {
      upstream.rc += 1;
      return Response.json({
        request_date_ms: Date.now(),
        subscriber: { entitlements: {} },
      });
    }
    upstream.other.push(`${request.method} ${request.url}`);
    return new Response(
      `stress-pg harness: unexpected fetch ${request.method} ${request.url}`,
      { status: 599 },
    );
  }) as typeof fetch;

  let handler: PgEdgeHarness["handler"] | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      | PgEdgeHarness["handler"]
      | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!handler) {
    throw new Error("index.ts did not register a Deno.serve handler");
  }
  loaded = { handler, sessions, upstream };
  return loaded;
}

// ── Disposable-DB users (owner role; seeded ids are wiped first) ─────────────

async function createUsers(
  sql: Sql,
  h: PgEdgeHarness,
  prng: Prng,
  count: number,
): Promise<User[]> {
  const users: User[] = [];
  for (let i = 0; i < count; i++) {
    const id = prng.uuid();
    const premium = prng.next() < 0.2;
    await sql.unsafe(`delete from auth.users where id = '${id}'`);
    await sql.unsafe(
      `insert into auth.users (id, email, raw_app_meta_data) values ('${id}', '${id}@example.com', '{"provider":"google"}')`,
    );
    await sql.unsafe(
      `insert into auth.identities (provider, provider_id, user_id, identity_data)
       values ('google', 'stress-${id}', '${id}', '{"sub":"stress-${id}"}')`,
    );
    if (premium) {
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, expires_at, product_key)
         values ('${id}', true, null, 'pickle_sensei_pro_lifetime')`,
      );
    }
    const accessToken = await signJwt({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: id,
      aud: "authenticated",
      role: "authenticated",
      session_id: prng.uuid(),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const user: User = {
      index: i,
      id,
      email: `${id}@example.com`,
      accessToken,
      premium,
      ip: `203.0.${(i >> 8) & 0xff}.${i & 0xff}`,
    };
    h.sessions.set(accessToken, user);
    users.push(user);
  }
  return users;
}

interface DbCounts {
  permits: number;
  reservedByUser: Map<string, number>;
  shots: number;
  ledger: number;
}

async function dbCounts(sql: Sql, userIds: string[]): Promise<DbCounts> {
  const list = userIds.map((id) => `'${id}'`).join(",");
  const permits = await sql.unsafe(
    `select user_id::text as user_id, count(*) filter (where status = 'reserved')::int as reserved, count(*)::int as n
       from public.analysis_permits where user_id in (${list}) group by 1`,
  );
  const shots = await sql.unsafe(
    `select count(*)::int as n from public.shots where user_id in (${list})`,
  );
  const ledger = await sql.unsafe(
    `select count(*)::int as n from public.free_rating_ledger`,
  );
  const reservedByUser = new Map<string, number>();
  let total = 0;
  for (const row of permits) {
    reservedByUser.set(String(row.user_id), Number(row.reserved));
    total += Number(row.n);
  }
  return {
    permits: total,
    reservedByUser,
    shots: Number(shots[0].n),
    ledger: Number(ledger[0].n),
  };
}

// ── Generators ───────────────────────────────────────────────────────────────

const ASCII =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:";
const UNICODE = "éüñßæ中文日本語한국어العربيةעברית✓☃♞€—“”";
const ASTRAL = ["😀", "🏓", "𝔘", "👨‍👩‍👧", "🇺🇸"];

function randomString(prng: Prng, alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[prng.int(0, alphabet.length - 1)];
  }
  return out;
}

/** A key ../index.ts accepts (string, non-blank, ≤ 128 UTF-16 units). */
function validKey(prng: Prng, index: number): string {
  switch (prng.int(0, 9)) {
    case 0:
      return prng.uuid();
    case 1:
      return "x".repeat(128);
    case 2:
      return randomString(prng, UNICODE, prng.int(1, 64));
    case 3: {
      let s = "";
      while (s.length + 2 <= 128) s += ASTRAL[prng.int(0, 1)];
      return s; // 128 UTF-16 units, 64 code points
    }
    case 4:
      return ` ${randomString(prng, ASCII, prng.int(1, 40))} `;
    case 5:
      return `'; drop table public.analysis_permits; --${index}`;
    case 6:
      return `\u202e${randomString(prng, ASCII, 12)}\u200b\ufeff`;
    case 7:
      return `key\twith\nnewline\r${index}`;
    case 8:
      return `${prng.uuid()}:${index}`;
    default:
      return randomString(prng, ASCII, prng.int(1, 128));
  }
}

type Kind =
  | "valid"
  | "replay"
  | "cross-user-replay"
  | "bad-body"
  | "bad-auth"
  | "burst-same-key"
  | "burst-distinct-keys";

interface Spec {
  index: number;
  kind: Kind;
  user: User | null;
  bearer: string | null;
  bodyText: string;
  key: string | null;
  replayOf?: number;
}

interface Outcome {
  index: number;
  seed: number;
  kind: Kind;
  user: number | null;
  premium: boolean | null;
  key: string | null;
  status: number;
  code: string | null;
  requestId: string | null;
  permitId: string | null;
  dbPermitsDelta: number;
  dbShotsDelta: number;
  dbLedgerDelta: number;
  reservedAfter: number | null;
  upstreamRest: number;
  latencyMs: number;
  violations: string[];
}

function reserveRequest(
  bearer: string | null,
  bodyText: string,
  ip: string,
): Request {
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-forwarded-for": ip,
  });
  if (bearer) headers.set("Authorization", bearer);
  return new Request(BASE + ROUTE, { method: "POST", headers, body: bodyText });
}

function checkCommon(
  status: number,
  text: string,
  headers: Headers,
  violations: string[],
): {
  code: string | null;
  requestId: string | null;
  body: Record<string, unknown> | null;
} {
  const requestId = headers.get("x-request-id");
  if (!requestId) violations.push("missing x-request-id");
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    body = isRecord(parsed) ? parsed : null;
  } catch {
    body = null;
  }
  const err = body && isRecord(body.error) ? body.error : null;
  const code = err && typeof err.code === "string" ? err.code : null;
  for (const marker of LEAK_MARKERS) {
    if (marker.test(text)) {
      violations.push(`body leaks internal detail (${marker})`);
    }
  }
  if (status >= 500) {
    if (!GENERIC_5XX.some((re) => re.test(text))) {
      violations.push(
        `5xx body is not the generic text: ${text.slice(0, 200)}`,
      );
    }
  }
  if (status === 429) {
    if (!headers.get("retry-after")) violations.push("429 without Retry-After");
    if (code !== "rate_limited") violations.push(`429 code ${code}`);
  }
  return { code, requestId, body };
}

// ── Campaign ─────────────────────────────────────────────────────────────────

Deno.test({
  name:
    `stress fuzz-boundary (postgres): POST /v1/analysis-permits × ${STRESS_PG_ITER} through real PostgREST/postgres:16 (seed ${STRESS_SEED})`,
  ignore,
  async fn() {
    const h = await loadPgEdgeHarness();
    const sql = postgres(PG_URL, { max: 4 });
    const accessLog: string[] = [];
    const restoreAccessLog = captureAccessLog((line) => accessLog.push(line));
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) =>
      logged.push(args.map(String).join(" ").slice(0, 300));
    const outcomes: Outcome[] = [];
    const t0 = performance.now();
    const heapBefore = Deno.memoryUsage();
    try {
      const prng = new Prng(STRESS_SEED ^ 0x50475354); // "PGST"
      const users = await createUsers(sql, h, prng, STRESS_PG_USERS);
      // Dedicated FREE accounts for the concurrent bursts: fresh, never touched
      // by the sequential campaign, so the allowance arithmetic is exact.
      const burstUsers = (await createUsers(sql, h, prng, STRESS_PG_BURSTS))
        .map((u) => ({ ...u, premium: false }));
      for (const u of burstUsers) {
        await sql.unsafe(
          `delete from public.billing_entitlements where user_id = '${u.id}'`,
        );
        h.sessions.set(u.accessToken, u);
      }
      const userIds = [...users, ...burstUsers].map((u) => u.id);
      /** user id → key → permit id (what the DB has told us so far) */
      const ledger = new Map<string, Map<string, string>>();
      const acceptedSpecs: Spec[] = [];

      const record = async (
        spec: Spec,
        ip: string,
        before: DbCounts,
      ): Promise<Outcome> => {
        const t = performance.now();
        const restBefore = h.upstream.rest;
        const response = await h.handler(
          reserveRequest(spec.bearer, spec.bodyText, ip),
        );
        const latencyMs = Math.round((performance.now() - t) * 100) / 100;
        const text = await response.text();
        const after = await dbCounts(sql, userIds);
        const violations: string[] = [];
        const { code, requestId, body } = checkCommon(
          response.status,
          text,
          response.headers,
          violations,
        );
        const status = response.status;
        const wellFormed = spec.kind !== "bad-body" && spec.kind !== "bad-auth";
        if (wellFormed) {
          if (![200, 402, 429].includes(status)) {
            violations.push(`well-formed reserve answered ${status}`);
          }
        } else if (!BAD_INPUT_STATUSES.has(status)) {
          violations.push(
            `bad input answered ${status} (allowed: 400/401/403/404/405/413/415/429)`,
          );
        }
        if (spec.kind === "bad-body" && status !== 400) {
          violations.push(`invalid body → ${status}, expected 400`);
        }
        if (spec.kind === "bad-auth" && status !== 401) {
          violations.push(`bad bearer → ${status}, expected 401`);
        }
        let permitId: string | null = null;
        if (status === 200) {
          const permit = body && isRecord(body.permit) ? body.permit : null;
          permitId = permit && typeof permit.id === "string" ? permit.id : null;
          if (!permitId) violations.push("200 without permit.id");
          if (permit && permit.status !== "reserved") {
            violations.push(`200 permit.status=${String(permit.status)}`);
          }
          const access = body && isRecord(body.access) ? body.access : null;
          if (!access) violations.push("200 without access");
          else if (spec.user && Boolean(access.premium) !== spec.user.premium) {
            violations.push(
              `access.premium=${
                String(access.premium)
              } for premium=${spec.user.premium}`,
            );
          }
        }
        if (status === 402 && code !== "access.paywall_required") {
          violations.push(`402 code ${code}`);
        }
        if (status === 402 && spec.user?.premium) {
          violations.push("premium account got 402");
        }
        const permitsDelta = after.permits - before.permits;
        if (status !== 200 && permitsDelta !== 0) {
          violations.push(
            `write on rejection: ${permitsDelta} permit row(s) for ${status}`,
          );
        }
        if (after.shots !== before.shots) {
          violations.push("shots row written by a reserve");
        }
        if (after.ledger !== before.ledger) {
          violations.push("free_rating_ledger row written by a reserve");
        }
        let reservedAfter: number | null = null;
        if (spec.user) {
          reservedAfter = after.reservedByUser.get(spec.user.id) ?? 0;
          if (!spec.user.premium && reservedAfter > 2) {
            violations.push(
              `P0 free account holds ${reservedAfter} reserved permits`,
            );
          }
          if (status === 200 && spec.key !== null) {
            const known = ledger.get(spec.user.id)?.get(spec.key);
            if (known && permitId !== known) {
              violations.push(
                `P0 replay of key returned permit ${permitId}, first was ${known}`,
              );
            }
            if (known && permitsDelta !== 0) {
              violations.push(`P0 replay inserted ${permitsDelta} row(s)`);
            }
            if (!known && permitsDelta !== 1) {
              violations.push(
                `fresh accepted key inserted ${permitsDelta} row(s), expected 1`,
              );
            }
            if (!known && permitId) {
              if (!ledger.has(spec.user.id)) {
                ledger.set(spec.user.id, new Map());
              }
              ledger.get(spec.user.id)!.set(spec.key, permitId);
            }
            if (
              spec.kind === "cross-user-replay" && spec.replayOf !== undefined
            ) {
              const other = outcomes[spec.replayOf];
              if (other?.permitId && other.permitId === permitId) {
                violations.push(
                  "P0 key shared across users returned the OTHER user's permit",
                );
              }
            }
          }
        }
        return {
          index: spec.index,
          seed: STRESS_SEED,
          kind: spec.kind,
          user: spec.user?.index ?? null,
          premium: spec.user?.premium ?? null,
          key: spec.key === null ? null : spec.key.slice(0, 140),
          status,
          code,
          requestId,
          permitId,
          dbPermitsDelta: permitsDelta,
          dbShotsDelta: after.shots - before.shots,
          dbLedgerDelta: after.ledger - before.ledger,
          reservedAfter,
          upstreamRest: h.upstream.rest - restBefore,
          latencyMs,
          violations,
        };
      };

      for (let i = 0; i < STRESS_PG_ITER; i++) {
        const roll = prng.int(0, 99);
        const user = users[prng.int(0, users.length - 1)];
        let spec: Spec;
        if (roll < 45 || acceptedSpecs.length === 0 && roll < 65) {
          const key = validKey(prng, i);
          spec = {
            index: i,
            kind: "valid",
            user,
            bearer: `Bearer ${user.accessToken}`,
            bodyText: JSON.stringify({ idempotencyKey: key }),
            key,
          };
        } else if (roll < 60) {
          const source = acceptedSpecs[prng.int(0, acceptedSpecs.length - 1)];
          spec = {
            ...source,
            index: i,
            kind: "replay",
            replayOf: source.index,
          };
        } else if (roll < 65) {
          const source = acceptedSpecs[prng.int(0, acceptedSpecs.length - 1)];
          const other = users[
            (source.user!.index + prng.int(1, users.length - 1)) %
            users.length
          ];
          spec = {
            index: i,
            kind: "cross-user-replay",
            user: other,
            bearer: `Bearer ${other.accessToken}`,
            bodyText: source.bodyText,
            key: source.key,
            replayOf: source.index,
          };
        } else if (roll < 85) {
          const bad = pickBadBody(prng);
          spec = {
            index: i,
            kind: "bad-body",
            user,
            bearer: `Bearer ${user.accessToken}`,
            bodyText: bad,
            key: null,
          };
        } else {
          const bearer = pickBadBearer(prng, user);
          spec = {
            index: i,
            kind: "bad-auth",
            user: null,
            bearer,
            bodyText: JSON.stringify({ idempotencyKey: prng.uuid() }),
            key: null,
          };
        }
        const before = await dbCounts(sql, userIds);
        const outcome = await record(
          spec,
          spec.user?.ip ?? `198.51.100.${i % 250}`,
          before,
        );
        outcomes.push(outcome);
        if (outcome.status === 200 && spec.kind === "valid") {
          acceptedSpecs.push(spec);
        }
      }

      // ── Concurrent bursts through the handler (the P0s) ──────────────────
      const bursts: Array<Record<string, unknown>> = [];
      for (const [b, user] of burstUsers.entries()) {
        const before = await dbCounts(sql, userIds);
        const sameKey = b % 2 === 0;
        const key = validKey(prng, 100_000 + b);
        const requests = Array.from(
          { length: STRESS_PG_LANES },
          (_, lane) =>
            reserveRequest(
              `Bearer ${user.accessToken}`,
              JSON.stringify({
                idempotencyKey: sameKey
                  ? key
                  : `${Array.from(key).slice(0, 50).join("")}-${lane}`,
              }),
              user.ip,
            ),
        );
        const responses = await Promise.all(requests.map((r) => h.handler(r)));
        const bodies = await Promise.all(responses.map((r) => r.text()));
        const after = await dbCounts(sql, userIds);
        const statuses = responses.map((r) => r.status);
        const permitIds = bodies.map((t) => {
          try {
            const j = JSON.parse(t);
            return isRecord(j) && isRecord(j.permit) &&
                typeof j.permit.id === "string"
              ? j.permit.id
              : null;
          } catch {
            return null;
          }
        });
        const violations: string[] = [];
        responses.forEach((r, i) =>
          checkCommon(r.status, bodies[i], r.headers, violations)
        );
        const distinctPermits = new Set(permitIds.filter(Boolean));
        const ok200 = statuses.filter((s) => s === 200).length;
        const reserved = after.reservedByUser.get(user.id) ?? 0;
        const rowsDelta = after.permits - before.permits;
        if (sameKey) {
          if (ok200 !== STRESS_PG_LANES) {
            violations.push(
              `same-key burst: ${ok200}/${STRESS_PG_LANES} accepted (statuses ${
                JSON.stringify(histogram(statuses))
              })`,
            );
          }
          if (distinctPermits.size !== 1) {
            violations.push(
              `P0 same-key burst produced ${distinctPermits.size} distinct permit ids`,
            );
          }
          if (rowsDelta !== 1) {
            violations.push(`P0 same-key burst inserted ${rowsDelta} rows`);
          }
        } else {
          if (ok200 !== 2) {
            violations.push(
              `P0 distinct-key burst on a fresh free account accepted ${ok200} (expected exactly 2)`,
            );
          }
          if (
            statuses.filter((s) => s === 402).length !== STRESS_PG_LANES - 2
          ) {
            violations.push(
              `distinct-key burst: statuses ${
                JSON.stringify(histogram(statuses))
              }`,
            );
          }
          if (rowsDelta !== 2) {
            violations.push(`P0 distinct-key burst inserted ${rowsDelta} rows`);
          }
        }
        if (reserved > 2) {
          violations.push(
            `P0 free account holds ${reserved} reserved permits after burst`,
          );
        }
        bursts.push({
          burst: b,
          mode: sameKey ? "same-key" : "distinct-keys",
          user: user.index,
          lanes: STRESS_PG_LANES,
          key: key.slice(0, 140),
          statuses: histogram(statuses),
          distinctPermitIds: distinctPermits.size,
          rowsDelta,
          reservedAfter: reserved,
          violations,
        });
        if (!ledger.has(user.id)) ledger.set(user.id, new Map());
      }

      const failures = outcomes.filter((o) => o.violations.length > 0);
      const burstFailures = bursts.filter((b) =>
        (b.violations as string[]).length > 0
      );
      const fiveXx = outcomes.filter((o) => o.status >= 500);
      const report = {
        scenario: "stress_analysis_permits_pg",
        seed: STRESS_SEED,
        configured: {
          iterations: STRESS_PG_ITER,
          users: STRESS_PG_USERS,
          lanes: STRESS_PG_LANES,
          bursts: STRESS_PG_BURSTS,
        },
        executed: outcomes.length,
        burstRequests: bursts.length * STRESS_PG_LANES,
        durationMs: Math.round(performance.now() - t0),
        heap: { before: heapBefore, after: Deno.memoryUsage() },
        statusHistogram: histogram(outcomes.map((o) => o.status)),
        statusByKind: Object.fromEntries(
          ([
            "valid",
            "replay",
            "cross-user-replay",
            "bad-body",
            "bad-auth",
          ] as Kind[]).map((k) => [
            k,
            histogram(
              outcomes.filter((o) => o.kind === k).map((o) => o.status),
            ),
          ]),
        ),
        upstream: {
          auth: h.upstream.auth,
          rest: h.upstream.rest,
          revenuecat: h.upstream.rc,
          other: h.upstream.other,
        },
        accessLogLines: accessLog.length,
        handlerLogLines: logged.length,
        handlerLogSample: logged.slice(0, 20),
        fiveXxIndexes: fiveXx.map((o) => o.index),
        failureIndexes: failures.map((o) => o.index),
        bursts,
        replay:
          `XC_PG_URL=<./xc_pg_up.sh> STRESS_POSTGREST_URL=<./stress_postgrest_up.sh> STRESS_PG_JWT_SECRET=<…> STRESS_SEED=${STRESS_SEED} STRESS_PG_ITER=${STRESS_PG_ITER} STRESS_PG_USERS=${STRESS_PG_USERS} STRESS_PG_LANES=${STRESS_PG_LANES} STRESS_PG_BURSTS=${STRESS_PG_BURSTS} deno test -A --no-check --config deno.json stress_analysis_permits_pg.test.ts`,
        outcomes,
      };
      const dir = stressOutDir();
      await Deno.mkdir(dir, { recursive: true });
      const path = `${dir}analysis_permits_pg.json`;
      await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
      console.log(
        `[stress-pg] ${outcomes.length} requests + ${bursts.length} bursts×${STRESS_PG_LANES}: ${failures.length} violating, ${burstFailures.length} bursts violating, statuses=${
          JSON.stringify(report.statusHistogram)
        } → ${path}`,
      );
      for (const f of failures.slice(0, 20)) {
        console.log(
          `[stress-pg]   #${f.index} ${f.kind} → ${f.status}: ${
            f.violations.join(" | ")
          }`,
        );
      }
      for (const b of burstFailures) {
        console.log(
          `[stress-pg]   burst ${b.burst} ${b.mode}: ${
            (b.violations as string[]).join(" | ")
          }`,
        );
      }
      assert(
        h.upstream.other.length === 0,
        `unexpected upstream calls: ${h.upstream.other.slice(0, 5).join(", ")}`,
      );
      assertEquals(outcomes.length, STRESS_PG_ITER);
      assertEquals(bursts.length, STRESS_PG_BURSTS);
      assertEquals(
        failures.length,
        0,
        `${failures.length} violating requests — see ${path}`,
      );
      assertEquals(
        burstFailures.length,
        0,
        `${burstFailures.length} violating bursts — see ${path}`,
      );
    } finally {
      console.error = realError;
      restoreAccessLog();
      await sql.end();
    }
  },
});

function pickBadBody(prng: Prng): string {
  switch (prng.int(0, 11)) {
    case 0:
      return "";
    case 1:
      return "{";
    case 2:
      return "null";
    case 3:
      return "[]";
    case 4:
      return JSON.stringify({});
    case 5:
      return JSON.stringify({ idempotencyKey: null });
    case 6:
      return JSON.stringify({ idempotencyKey: prng.int(0, 1e9) });
    case 7:
      return JSON.stringify({ idempotencyKey: ["a"] });
    case 8:
      return JSON.stringify({ idempotencyKey: { toString: "x" } });
    case 9:
      return JSON.stringify({
        idempotencyKey: " \t\n\u00a0 ".slice(0, prng.int(1, 6)),
      });
    case 10:
      return JSON.stringify({
        idempotencyKey: "x".repeat(129 + prng.int(0, 5000)),
      });
    default:
      return JSON.stringify({ IdempotencyKey: prng.uuid() });
  }
}

function pickBadBearer(prng: Prng, user: User): string | null {
  const [head, payload] = user.accessToken.split(".");
  switch (prng.int(0, 5)) {
    case 0:
      return null;
    case 1:
      return "Bearer ";
    case 2:
      return `Bearer ${head}.${payload}.forged-signature`; // GoTrue stub: unknown session → 401
    case 3:
      return `Bearer ${randomString(prng, ASCII, prng.int(1, 200))}`;
    case 4: {
      // structurally valid, expired
      const claims = JSON.parse(
        atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
      );
      claims.exp = Math.floor(Date.now() / 1000) - 60;
      return `Bearer ${head}.${b64url(JSON.stringify(claims))}.sig`;
    }
    default:
      return `Basic ${btoa("user:pass")}`;
  }
}

// ── Boundaries the modelled DB cannot see: strings that are valid JS strings
// (so ../index.ts accepts them: non-blank, ≤ 128 UTF-16 units) but that
// Postgres cannot hold as `text` — U+0000, and unpaired UTF-16 surrogates,
// which JSON.stringify emits as `\ud83d`-style escapes. PostgREST/Postgres
// refuse the json→text conversion (22P05) and the route maps every RPC error
// to 503. Bad input must be a 4xx — this pins the contract.

Deno.test({
  name:
    "stress fuzz-boundary (postgres): idempotencyKey with U+0000 or an unpaired surrogate is rejected as 4xx, never 5xx, and writes nothing",
  ignore,
  async fn() {
    const h = await loadPgEdgeHarness();
    const sql = postgres(PG_URL, { max: 2 });
    const restoreAccessLog = captureAccessLog(() => undefined);
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) =>
      logged.push(args.map(String).join(" ").slice(0, 300));
    try {
      const prng = new Prng(STRESS_SEED ^ 0x4e554c00); // "NUL"
      const [user] = await createUsers(sql, h, prng, 1);
      const cases = [
        "a\u0000b",
        "\u0000",
        `${prng.uuid()}\u0000`,
        "\u0000".repeat(128),
        "\ud83d", // lone high surrogate
        "\ude00", // lone low surrogate
        `${prng.uuid()}\ud83d`,
        "😀".repeat(64).slice(0, 127), // 128-unit astral key cut mid-pair
      ];
      const results: Array<Record<string, unknown>> = [];
      for (const key of cases) {
        const before = await dbCounts(sql, [user.id]);
        const response = await h.handler(
          reserveRequest(
            `Bearer ${user.accessToken}`,
            JSON.stringify({ idempotencyKey: key }),
            user.ip,
          ),
        );
        const text = await response.text();
        const after = await dbCounts(sql, [user.id]);
        results.push({
          key: JSON.stringify(key).slice(0, 60),
          status: response.status,
          body: text.slice(0, 200),
          requestId: response.headers.get("x-request-id"),
          rowsDelta: after.permits - before.permits,
          serverLog: logged.splice(0).map((l) => l.slice(0, 200)),
        });
      }
      const dir = stressOutDir();
      await Deno.mkdir(dir, { recursive: true });
      const path = `${dir}analysis_permits_pg_unencodable_key.json`;
      await Deno.writeTextFile(
        path,
        JSON.stringify({ seed: STRESS_SEED, user: user.id, results }, null, 2),
      );
      console.log(
        `[stress-pg] unencodable-key probe → ${path}: ${
          results.map((r) => r.status).join(",")
        }`,
      );
      for (const r of results) {
        assert(r.requestId, `missing x-request-id for ${r.key}`);
        assertEquals(r.rowsDelta, 0, `key ${r.key} wrote a row`);
        assert(
          !/PGRST|22P05|postgres/i.test(String(r.body)),
          `body leaks PostgREST detail for ${r.key}`,
        );
      }
      for (const r of results) {
        assert(
          BAD_INPUT_STATUSES.has(Number(r.status)),
          `key ${r.key} → ${r.status} ${r.body} (expected a 4xx: client-controlled input must not surface as a 5xx)`,
        );
      }
    } finally {
      console.error = realError;
      restoreAccessLog();
      await sql.end();
    }
  },
});
