// Fuzz/boundary harness for the edge route `PUT /v1/me/onboarding`.
//
// It boots the REAL handler (../index.ts with Deno.serve captured, so no port
// is opened) with Supabase Auth, PostgREST and RevenueCat stubbed at the fetch
// layer — same shape as routesHarness.ts, with three differences the lens
// needs:
//
//   1. PostgREST PATCH on `profiles` answers like the hosted one (Prefer:
//      return=representation + Accept: vnd.pgrst.object+json → the updated
//      row), so the accepted path really reaches 200 and every write is
//      recorded verbatim (payload keys are evidence against mass assignment).
//   2. Faults are injectable per iteration (auth 500, PostgREST 500 with a
//      hostile detail, 0-rows update, RevenueCat down) so the "generic 5xx,
//      no internal detail" invariant is exercised, not assumed.
//   3. A seeded PRNG plus generators for bodies / query strings / headers /
//      path forms; every iteration is a pure function of its seed, so any
//      failure replays from `STRESS_SEED=<seed> STRESS_ITER=1`.
//
// Nothing here touches the network: the only fetch that exists is the fake.

import { sanitizeUserText } from "../http.ts";

export const SUPABASE_URL = "http://supabase.stress.test";
const ANON_KEY = "stress-anon-key";
const SERVICE_ROLE_KEY = "stress-service-role-key";
export const WEBHOOK_SECRET = "stress-webhook-secret";

/** Detail strings the fake upstreams put in their error payloads. If any of
 * these ever reaches a client response body, the 5xx is not generic. */
export const LEAK_MARKERS = [
  "permission denied for table profiles",
  "PGRST",
  "42501",
  "supabase.stress.test",
  ANON_KEY,
  SERVICE_ROLE_KEY,
  "index.ts:",
  "    at ",
] as const;

export type Fault =
  | "none"
  | "db_500_hostile_detail"
  | "db_zero_rows"
  | "db_column_grant_denied"
  | "auth_500";

export interface RecordedWrite {
  method: string;
  table: string;
  query: string;
  body: Record<string, unknown>;
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  /** Every PostgREST call the handler made this iteration. */
  writes: RecordedWrite[];
  /** Non-PostgREST upstream calls (auth, RevenueCat) this iteration. */
  upstream: Array<{ method: string; url: string }>;
  /** Fake upstreams the harness did not expect (status 599 answers). */
  unexpected: string[];
  /** Anything the handler wrote to console.error / console.warn. */
  logs: string[];
  fault: Fault;
  reset(fault?: Fault): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A syntactically valid Google ID token (issuer routing only — signature
 * verification lives in the fake Supabase Auth). */
export function providerIdToken(
  sub: string,
  options: { iss?: string; expOffsetSeconds?: number; dropSub?: boolean } = {},
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims: Record<string, unknown> = {
    iss: options.iss ?? "https://accounts.google.com",
    exp: Math.floor(Date.now() / 1000) + (options.expOffsetSeconds ?? 3600),
  };
  if (!options.dropSub) claims.sub = sub;
  return `${header}.${b64url(JSON.stringify(claims))}.sig`;
}

/** A Supabase-issued ACCESS token in the shape authenticate() expects
 * (issuer ending in /auth/v1, a session_id claim). */
export function sessionAccessToken(
  sub: string,
  options: { expOffsetSeconds?: number } = {},
): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = {
    iss: `${SUPABASE_URL}/auth/v1`,
    sub,
    session_id: `sess-${sub}`,
    exp: Math.floor(Date.now() / 1000) + (options.expOffsetSeconds ?? 3600),
  };
  return `${header}.${b64url(JSON.stringify(claims))}.sig`;
}

/** Columns the route is allowed to write. Anything else in a recorded PATCH
 * body is mass assignment. */
export const ALLOWED_PATCH_KEYS = new Set([
  "skill_level",
  "handedness",
  "primary_goal",
  "biggest_problem",
  "focus_checkpoint",
  "onboarding_state",
  "first_name",
  "gender",
]);

/** char_length caps the profiles table enforces (20260829130000 +
 * 20260831160000). The edge validator must never accept past these. */
export const DB_TEXT_CAPS: Record<string, number> = {
  skill_level: 100,
  primary_goal: 200,
  biggest_problem: 500,
  first_name: 80,
  focus_checkpoint: 100,
  onboarding_state: 40,
};

export const GENDER_OPTIONS = new Set([
  "female",
  "male",
  "nonbinary",
  "prefer_not_to_say",
]);

/** GOAL_FOCUS from index.ts — the accepted-path oracle for focusCheckpoint. */
export const GOAL_FOCUS: Record<string, string> = {
  dinks: "contact_position",
  drives: "preparation",
  drops: "paddle_set",
  serve: "sequencing",
  return: "athletic_base",
  volleys: "face_wrist_stability",
  footwork: "athletic_base",
  "all-around": "contact_position",
};

export const sanitize = sanitizeUserText;

let harness: StressHarness | null = null;

export async function loadStressHarness(): Promise<StressHarness> {
  if (harness) {
    harness.reset();
    return harness;
  }

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", WEBHOOK_SECRET);
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    writes: [],
    upstream: [],
    unexpected: [],
    logs: [],
    fault: "none",
    reset(fault: Fault = "none") {
      state.writes = [];
      state.upstream = [];
      state.unexpected = [];
      state.logs = [];
      state.fault = fault;
    },
  };

  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const pgrstError = (
    status: number,
    payload: Record<string, unknown>,
  ): Response =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const href = request.url;
    const text = await request.text().catch(() => "");
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    // ── RevenueCat
    if (href.startsWith("https://api.revenuecat.com/")) {
      state.upstream.push({ method: request.method, url: href });
      return jsonResponse(200, {
        request_date_ms: Date.now(),
        subscriber: {},
      });
    }

    // ── Supabase Auth: the id_token grant (provider bearer) …
    if (href.startsWith(`${SUPABASE_URL}/auth/v1/token`)) {
      state.upstream.push({ method: request.method, url: href });
      if (state.fault === "auth_500") {
        return jsonResponse(500, {
          message: "GoTrue is down (permission denied for table profiles)",
        });
      }
      const payload = isRecord(parsed) ? parsed : {};
      const token = typeof payload.id_token === "string"
        ? payload.id_token
        : "";
      const segment = token.split(".")[1] ?? "";
      let sub: string | null = null;
      try {
        const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
        const claims = JSON.parse(
          atob(raw + "=".repeat((4 - (raw.length % 4)) % 4)),
        );
        sub = typeof claims.sub === "string" ? claims.sub : null;
      } catch {
        sub = null;
      }
      if (!sub) {
        return jsonResponse(400, {
          error: "invalid_grant",
          error_description: "bad id_token",
        });
      }
      return jsonResponse(200, {
        access_token: sessionAccessToken(sub),
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: `refresh-${sub}`,
        user: {
          id: sub,
          aud: "authenticated",
          role: "authenticated",
          email: "player@example.com",
          app_metadata: { provider: "google", providers: ["google"] },
          user_metadata: {},
          created_at: new Date().toISOString(),
        },
      });
    }

    // … and getUser() for a Supabase ACCESS-token bearer.
    if (href.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      state.upstream.push({ method: request.method, url: href });
      if (state.fault === "auth_500") {
        return jsonResponse(500, {
          message: "GoTrue is down (permission denied for table profiles)",
        });
      }
      const bearer = (request.headers.get("authorization") ?? "").replace(
        /^Bearer\s+/i,
        "",
      );
      const segment = bearer.split(".")[1] ?? "";
      let sub: string | null = null;
      try {
        const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
        const claims = JSON.parse(
          atob(raw + "=".repeat((4 - (raw.length % 4)) % 4)),
        );
        sub = typeof claims.sub === "string" ? claims.sub : null;
      } catch {
        sub = null;
      }
      if (!sub) {
        return jsonResponse(401, {
          message: "invalid claim: missing sub claim",
        });
      }
      return jsonResponse(200, {
        id: sub,
        aud: "authenticated",
        role: "authenticated",
        email: "player@example.com",
        app_metadata: { provider: "google", providers: ["google"] },
        user_metadata: {},
        created_at: new Date().toISOString(),
      });
    }

    // ── PostgREST
    if (href.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      const table = url.pathname.slice("/rest/v1/".length);
      const body = isRecord(parsed) ? parsed : {};
      state.writes.push({
        method: request.method,
        table,
        query: url.search,
        body,
      });
      if (request.method === "PATCH" && table === "profiles") {
        if (state.fault === "db_500_hostile_detail") {
          return pgrstError(500, {
            code: "XX000",
            message:
              "permission denied for table profiles\n    at PostgREST (index.ts:3560)",
            details: `failing row contains ${
              JSON.stringify(body).slice(0, 200)
            }`,
            hint: "grant UPDATE on public.profiles",
          });
        }
        if (state.fault === "db_column_grant_denied") {
          return pgrstError(403, {
            code: "42501",
            message: "permission denied for table profiles",
            details: null,
            hint: null,
          });
        }
        if (state.fault === "db_zero_rows") {
          // maybeSingle() reads PGRST116 as "no row" (data null, error null).
          return pgrstError(406, {
            code: "PGRST116",
            message: "0 rows",
            details: null,
            hint: null,
          });
        }
        return jsonResponse(200, {
          skill_level: body.skill_level ?? null,
          handedness: body.handedness ?? null,
          primary_goal: body.primary_goal ?? null,
          biggest_problem: body.biggest_problem ?? null,
          focus_checkpoint: body.focus_checkpoint ?? null,
          first_name: body.first_name ?? null,
          gender: body.gender ?? null,
        });
      }
      if (request.method === "GET") {
        const accept = request.headers.get("accept") ?? "";
        if (accept.includes("application/vnd.pgrst.object+json")) {
          return jsonResponse(200, {
            id: "stub",
            onboarding_state: "complete",
          });
        }
        return jsonResponse(200, []);
      }
      if (request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 201 });
    }

    state.unexpected.push(`${request.method} ${href}`);
    return new Response(
      `stress harness: unexpected fetch ${request.method} ${href}`,
      {
        status: 599,
      },
    );
  }) as typeof fetch;

  const realError = console.error;
  const realWarn = console.warn;
  const record =
    (sink: (...args: unknown[]) => void) => (...args: unknown[]) => {
      state.logs.push(
        args.map((a) => (typeof a === "string" ? a : String(a))).join(" "),
      );
      void sink;
    };
  console.error = record(realError) as typeof console.error;
  console.warn = record(realWarn) as typeof console.warn;

  Deno.serve = ((...args: unknown[]) => {
    const handler = args.find((arg) => typeof arg === "function") as
      | ((request: Request) => Promise<Response>)
      | undefined;
    if (!handler) throw new Error("Deno.serve called without a handler");
    state.handler = handler;
    return {
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
      ref() {},
      unref() {},
      shutdown: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as unknown as ReturnType<typeof Deno.serve>;
  }) as typeof Deno.serve;

  await import("../index.ts");
  harness = state;
  return state;
}

// ── Seeded PRNG ──────────────────────────────────────────────────────────────

export interface Rng {
  /** [0,1) */
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

/** mulberry32 — 32-bit, deterministic, dependency-free. */
export function rngFor(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(maxExclusive: number) {
      return Math.floor(next() * maxExclusive);
    },
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)];
    },
    chance(probability: number) {
      return next() < probability;
    },
  };
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function histogram(
  values: Array<string | number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-route-put-onboarding/latest/",
    import.meta.url,
  )
    .pathname;
}

export async function writeArtifact(
  name: string,
  payload: unknown,
): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(payload, null, 2));
  return path;
}
