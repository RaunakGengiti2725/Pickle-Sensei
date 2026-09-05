/**
 * stress — FUZZ/BOUNDARY campaign for POST /v1/analysis-permits/:id/finalize
 * (the "release" half of the permit contract; scored consumption is
 * POST /v1/shots:sync by design — see finalizeAnalysisPermitRoute in
 * ../index.ts).
 *
 * Every iteration derives ONE seed (iterationSeed(STRESS_SEED, i)), builds
 * its own fixture (fresh users, sessions, permits) and ONE generated request
 * (method / path prefix / path segment / query / headers / body / auth /
 * permit state / injected upstream fault) purely from that seed, sends it to
 * the REAL handler in-process (stress_permits_finalize_harness.ts) and
 * checks, against an oracle that mirrors the documented contract:
 *
 *   - status ∈ oracle set; bad input only ever 400/401/403/404/405/413/415/429
 *   - every 5xx is one of the two generic bodies, no stack / file / SQLSTATE /
 *     PostgREST / upstream detail in ANY body
 *   - `x-request-id` on every response (client id echoed only when well-formed)
 *   - no write on rejection: the permit table is byte-identical after every
 *     non-200, and a 200 changes exactly the target row
 *   - captured function logs never contain the bearer
 *
 * Results: <STRESS_OUT_DIR>/fuzz_results.json (seed → outcome table),
 * fuzz_failures.json, fuzz_5xx.json (every seed/payload that produced a 5xx).
 *
 *   STRESS_ITER=3000 STRESS_SEED=20260905 STRESS_OUT_DIR=/tmp/stress/ \
 *     deno test -A --no-check --config deno.json stress_permits_finalize_fuzz.test.ts
 *   STRESS_REPLAY=<iterSeed[,iterSeed…]> …  # replay exactly those iterations
 *
 * Default STRESS_ITER is small so the file lives in `deno task test`.
 */
import { assert, assertEquals } from "@std/assert";
import {
  auditResponse,
  buildRequest,
  captureConsole,
  type EdgeRequestSpec,
  envInt,
  type Fault,
  type FaultMode,
  type FaultTarget,
  FinalizeFake,
  histogram,
  iterationSeed,
  Prng,
  RELEASABLE_OUTCOMES,
  REQUEST_ID_RE,
  type ResponseAudit,
  sleep,
  type StressPermit,
  type StressSession,
  SUPABASE_URL,
  UUID_V4_RE,
  withStressHarness,
  writeJson,
} from "./stress_permits_finalize_harness.ts";
import { captureAccessLog } from "../http.ts";

const STRESS_ITER = envInt("STRESS_ITER", 250);
const STRESS_SEED = envInt("STRESS_SEED", 20260905);
const STRESS_ROUNDS = envInt("STRESS_ROUNDS", 4);
const STRESS_BURST = envInt("STRESS_BURST", 12);
const REPLAY = (Deno.env.get("STRESS_REPLAY") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter((n) => Number.isFinite(n) && n >= 0);

const MAX_JSON_BODY_BYTES = 5_000_000;
const BAD_INPUT_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 429]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── Generated scenario ───────────────────────────────────────────────────────

type Category =
  | "happy"
  | "auth"
  | "path"
  | "body"
  | "state"
  | "fault"
  | "headers"
  | "method";

interface Oracle {
  statuses: number[];
  code: string | null;
  /** "finalize" — the target row is expected to flip to finalized/<outcome>. */
  writes: "none" | "finalize";
  /** A 503 that lands AFTER the guarded UPDATE committed (access_state fault):
   * the write is legitimate and the very next replay must return 200. */
  writeThen5xx: boolean;
  generic5xx: boolean;
}

interface Scenario {
  iteration: number;
  seed: number;
  category: Category;
  description: string;
  spec: EdgeRequestSpec;
  oracle: Oracle;
  /** the permit the request addresses (null when none exists / not own) */
  target: StressPermit | null;
  targetIdInPath: string;
  outcome: string | null;
  session: StressSession | null;
  /** the request-id the client sent, if any */
  clientRequestId: string | null;
  fault: Fault | null;
  /** number of reserved unexpired permits the user holds BEFORE the request */
  reservedBefore: number;
  /** a follow-up identical request must succeed (duplicate delivery) */
  replayExpected: number[] | null;
}

const PREFIXES = ["/functions/v1/api/v1", "/v1", "/api/v1"];
const SAFE_QUERY_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-_.~";
const HEADER_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !#$%&'()*+,-./:;<=>?@[]^_`{|}~";

function pick<T>(rng: Prng, items: readonly T[]): T {
  return items[rng.int(0, items.length - 1)];
}

function chars(rng: Prng, alphabet: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[rng.int(0, alphabet.length - 1)];
  return out;
}

function ip(rng: Prng): string {
  return `${rng.int(11, 223)}.${rng.int(0, 255)}.${rng.int(0, 255)}.${
    rng.int(1, 254)
  }`;
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

function providerIdToken(sub: string, iss: string, exp?: number): string {
  const b64 = (s: string) =>
    btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${
    b64(
      JSON.stringify({
        iss,
        sub,
        exp: exp ?? Math.floor(Date.now() / 1000) + 3600,
      }),
    )
  }.sig`;
}

interface Fixture {
  userA: string;
  userB: string;
  sessionA: StressSession;
  sessionB: StressSession;
  target: StressPermit;
  decoys: StressPermit[];
  permitB: StressPermit;
}

async function buildFixture(
  fake: FinalizeFake,
  rng: Prng,
  targetState: {
    status: StressPermit["status"];
    outcome: string | null;
    ageMs?: number;
  },
): Promise<Fixture> {
  const userA = rng.uuid();
  const userB = rng.uuid();
  const sessionA = await fake.mintSession(
    userA,
    pick(rng, ["google", "apple"] as const),
  );
  const sessionB = await fake.mintSession(userB, "google");
  const decoys: StressPermit[] = [];
  const decoyCount = rng.int(0, 2);
  for (let d = 0; d < decoyCount; d++) {
    const kind = rng.int(0, 2);
    decoys.push(
      kind === 0
        ? fake.addPermit(userA, "reserved", null, {
          ageMs: rng.int(0, 3_600_000),
        })
        : kind === 1
        ? fake.addPermit(
          userA,
          "finalized",
          pick(rng, ["scored", ...RELEASABLE_OUTCOMES]),
        )
        : fake.addPermit(userA, "released", "expired", {
          ageMs: 30 * 3_600_000,
        }),
    );
  }
  const target = fake.addPermit(
    userA,
    targetState.status,
    targetState.outcome,
    {
      ageMs: targetState.ageMs ?? rng.int(0, 600_000),
    },
  );
  const permitB = fake.addPermit(userB, "reserved", null);
  return { userA, userB, sessionA, sessionB, target, decoys, permitB };
}

function reservedCount(fake: FinalizeFake, userId: string): number {
  const cutoff = Date.now() - 24 * 3_600_000;
  return fake.permits.filter(
    (p) =>
      p.user_id === userId && p.status === "reserved" &&
      Date.parse(p.created_at) > cutoff,
  ).length;
}

/** Mirror of the handler's path normalisation + route regex. */
function routeOracle(
  method: string,
  pathname: string,
): { kind: "unknown" } | { kind: "malformed" } | {
  kind: "finalize";
  permitId: string;
} {
  const v1 = pathname.lastIndexOf("/v1/");
  const path = v1 >= 0 ? pathname.slice(v1) : pathname;
  if (method !== "POST") return { kind: "unknown" };
  const m = /^\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(path);
  if (!m) return { kind: "unknown" };
  try {
    return { kind: "finalize", permitId: decodeURIComponent(m[1]) };
  } catch {
    return { kind: "malformed" };
  }
}

/** Mirror of readBody (bounded text → JSON.parse → record or {}). */
function bodyOracle(
  body: string | Uint8Array | undefined,
): Record<string, unknown> | "too_large" {
  if (body === undefined) return {};
  const bytes = typeof body === "string"
    ? new TextEncoder().encode(body)
    : body;
  if (bytes.byteLength > MAX_JSON_BODY_BYTES) return "too_large";
  // TextDecoder (as in readBoundedText) strips a leading BOM.
  const text = new TextDecoder().decode(bytes);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const VALIDATION = "validation.analysis_permit_finalize";
const NOT_FOUND = "access.permit_not_found";
const CONFLICT = "access.permit_already_finalized";

function oracleFor(
  fake: FinalizeFake,
  fixture: Fixture,
  spec: EdgeRequestSpec,
  authKind: "valid" | "invalid" | "other_user" | "provider_valid",
  fault: Fault | null,
): { oracle: Oracle; target: StressPermit | null; outcome: string | null } {
  const none = (
    statuses: number[],
    code: string | null,
    generic5xx = false,
  ): Oracle => ({
    statuses,
    code,
    writes: "none",
    writeThen5xx: false,
    generic5xx,
  });
  const declared = Number(spec.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
    return { oracle: none([413], null), target: null, outcome: null };
  }
  if (authKind === "invalid") {
    return { oracle: none([401], null), target: null, outcome: null };
  }
  if (
    fault?.target === "gotrue_user" && authKind === "valid" &&
    fault.mode !== "throw"
  ) {
    // one socket failure ("throw") is retried inside the deadline and heals;
    // every other fault is a retryable 503 — never a verdict on the bearer.
    return { oracle: none([503], null, true), target: null, outcome: null };
  }
  if (fault?.target === "gotrue_token" && authKind === "provider_valid") {
    // Contract (index.ts header): 401/403 are verdicts on the credential, 5xx
    // is "retryable unavailable". An Auth outage during the transitional
    // provider-token exchange therefore has to surface as a generic 503.
    return { oracle: none([503], null, true), target: null, outcome: null };
  }
  const route = routeOracle(spec.method, spec.pathname);
  if (route.kind === "unknown") {
    return { oracle: none([404], null), target: null, outcome: null };
  }
  if (route.kind === "malformed") {
    return { oracle: none([400], null), target: null, outcome: null };
  }
  if (!UUID_RE.test(route.permitId)) {
    return { oracle: none([400], VALIDATION), target: null, outcome: null };
  }
  const body = bodyOracle(spec.body);
  if (body === "too_large") {
    return { oracle: none([413], null), target: null, outcome: null };
  }
  const outcome = body.outcome;
  if (
    typeof outcome !== "string" ||
    !(RELEASABLE_OUTCOMES as readonly string[]).includes(outcome)
  ) {
    return { oracle: none([400], VALIDATION), target: null, outcome: null };
  }
  if (body.ratingId !== null && body.ratingId !== undefined) {
    return { oracle: none([400], VALIDATION), target: null, outcome: null };
  }
  if (fault?.target === "pg_select" && fault.mode !== "throw") {
    // supabase-js retries a GET whose socket failed (1 s, 2 s, 4 s), so ONE
    // "throw" heals into the normal path; HTTP faults and a dead socket
    // (throw_sticky, exercised in the C-suite) are a generic 503 with no write.
    return { oracle: none([503], null, true), target: null, outcome };
  }
  const actingUser = authKind === "other_user" ? fixture.userB : fixture.userA;
  const row = fake.permits.find(
    (p) =>
      p.id.toLowerCase() === route.permitId.toLowerCase() &&
      p.user_id === actingUser,
  );
  if (!row) return { oracle: none([404], NOT_FOUND), target: null, outcome };
  if (row.status !== "reserved") {
    if (row.outcome === outcome) {
      if (fault?.target === "rpc_access") {
        return { oracle: none([503], null, true), target: row, outcome };
      }
      return { oracle: none([200], null), target: row, outcome };
    }
    return { oracle: none([409], CONFLICT), target: row, outcome };
  }
  if (fault?.target === "pg_update") {
    return { oracle: none([503], null, true), target: row, outcome };
  }
  if (fault?.target === "rpc_access") {
    return {
      oracle: {
        statuses: [503],
        code: null,
        writes: "finalize",
        writeThen5xx: true,
        generic5xx: true,
      },
      target: row,
      outcome,
    };
  }
  return {
    oracle: {
      statuses: [200],
      code: null,
      writes: "finalize",
      writeThen5xx: false,
      generic5xx: false,
    },
    target: row,
    outcome,
  };
}

const CATEGORY_WEIGHTS: Array<[Category, number]> = [
  ["happy", 14],
  ["auth", 14],
  ["path", 20],
  ["body", 24],
  ["state", 10],
  ["fault", 8],
  ["headers", 6],
  ["method", 4],
];

function pickCategory(rng: Prng): Category {
  const total = CATEGORY_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let roll = rng.int(1, total);
  for (const [category, weight] of CATEGORY_WEIGHTS) {
    roll -= weight;
    if (roll <= 0) return category;
  }
  return "happy";
}

const PG_FAULT_MODES: FaultMode[] = [
  "http500_json",
  "http502_html",
  "http200_garbage",
  "throw",
];
/** PATCH/RPC are not retried by supabase-js, so a dead socket is instant. */
const PG_WRITE_FAULT_MODES: FaultMode[] = [...PG_FAULT_MODES, "throw_sticky"];
const AUTH_FAULT_MODES: FaultMode[] = [
  "http500_json",
  "http502_html",
  "http200_garbage",
  "http200_empty",
  "throw",
  "throw_sticky",
];

/** Build one fully seeded scenario: fixture + request + oracle. */
async function generate(
  fake: FinalizeFake,
  iteration: number,
  seed: number,
): Promise<Scenario> {
  const rng = new Prng(seed);
  fake.reset(seed, 0);
  const category = pickCategory(rng);

  // ── target permit state ──
  let targetState: {
    status: StressPermit["status"];
    outcome: string | null;
    ageMs?: number;
  } = {
    status: "reserved",
    outcome: null,
  };
  let stateNote = "target=reserved";
  if (category === "state") {
    const kind = rng.int(0, 5);
    if (kind === 0) {
      const o = pick(rng, RELEASABLE_OUTCOMES);
      targetState = { status: "finalized", outcome: o };
      stateNote = `target=finalized/${o}`;
    } else if (kind === 1) {
      targetState = { status: "finalized", outcome: "scored" };
      stateNote = "target=finalized/scored";
    } else if (kind === 2) {
      targetState = {
        status: "released",
        outcome: "expired",
        ageMs: 26 * 3_600_000,
      };
      stateNote = "target=released/expired";
    } else if (kind === 3) {
      targetState = {
        status: "reserved",
        outcome: null,
        ageMs: 25 * 3_600_000,
      };
      stateNote = "target=reserved but older than 24h";
    } else if (kind === 4) {
      stateNote = "target=other user's permit";
    } else {
      stateNote = "target=nonexistent id";
    }
  }
  const fixture = await buildFixture(fake, rng, targetState);
  const reservedBefore = reservedCount(fake, fixture.userA);

  // ── defaults (a valid request) ──
  let method = "POST";
  let prefix = pick(rng, PREFIXES);
  let segment = fixture.target.id;
  let suffix = "/finalize";
  let query = "";
  let outcome: string | null = pick(rng, RELEASABLE_OUTCOMES);
  let bodyValue: unknown = { outcome };
  let body: string | Uint8Array | undefined = undefined;
  let bodyNote = `body={outcome:${outcome}}`;
  const headers: Record<string, string> = {
    "x-forwarded-for": ip(rng),
    "content-type": "application/json",
  };
  let authKind: "valid" | "invalid" | "other_user" | "provider_valid" = "valid";
  let authNote = "auth=session A";
  let session: StressSession | null = fixture.sessionA;
  let fault: Fault | null = null;
  let clientRequestId: string | null = null;
  let pathNote = "";

  // random decorations that must never change the verdict
  if (rng.next() < 0.3) {
    clientRequestId = chars(
      rng,
      "abcdefghijklmnopqrstuvwxyz0123456789._-",
      rng.int(8, 64),
    );
    headers["x-request-id"] = clientRequestId;
  }
  if (rng.next() < 0.2) {
    query = `?${chars(rng, SAFE_QUERY_CHARS, rng.int(1, 12))}=${
      chars(rng, SAFE_QUERY_CHARS, rng.int(0, 40))
    }`;
  }
  if (rng.next() < 0.15) {
    bodyValue = { ...(bodyValue as Record<string, unknown>), ratingId: null };
    bodyNote += "+ratingId:null";
  }
  if (rng.next() < 0.15) {
    bodyValue = {
      ...(bodyValue as Record<string, unknown>),
      [chars(rng, "abcdefghijklmnopqrstuvwxyz", rng.int(1, 16))]: chars(
        rng,
        HEADER_CHARS,
        rng.int(0, 64),
      ),
    };
    bodyNote += "+extra field";
  }
  if (rng.next() < 0.1) {
    headers["content-type"] = pick(rng, [
      "text/plain",
      "application/octet-stream",
      "multipart/form-data; boundary=x",
      "application/json; charset=utf-8",
    ]);
  }

  switch (category) {
    case "happy":
      break;

    case "method": {
      method = pick(rng, ["GET", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]);
      pathNote = `method=${method}`;
      break;
    }

    case "auth": {
      const kind = rng.int(0, 12);
      authKind = "invalid";
      session = null;
      if (kind === 0) {
        delete headers.authorization;
        authNote = "auth=missing";
      } else if (kind === 1) {
        headers.authorization = "Bearer ";
        authNote = "auth=empty bearer";
      } else if (kind === 2) {
        headers.authorization = `bearer ${fixture.sessionA.accessToken}`;
        authNote = "auth=lowercase scheme";
      } else if (kind === 3) {
        headers.authorization = `Basic ${btoa("user:pass")}`;
        authNote = "auth=basic";
      } else if (kind === 4) {
        headers.authorization = `Bearer ${
          chars(rng, HEADER_CHARS.replace(/[\s,;]/g, ""), rng.int(1, 200))
        }`;
        authNote = "auth=garbage token";
      } else if (kind === 5) {
        const [h, p] = fixture.sessionA.accessToken.split(".");
        headers.authorization = `Bearer ${h}.${p}`;
        authNote = "auth=two-segment jwt";
      } else if (kind === 6) {
        headers.authorization = `Bearer a.${chars(rng, "!@#", 10)}.c`;
        authNote = "auth=unparseable payload";
      } else if (kind === 7) {
        const expired = await fake.mintSession(fixture.userA, "google", {
          exp: Math.floor(Date.now() / 1000) - rng.int(1, 100_000),
        });
        headers.authorization = `Bearer ${expired.accessToken}`;
        authNote = "auth=expired session token";
      } else if (kind === 8) {
        const revoked = await fake.mintSession(fixture.userA, "google");
        revoked.revoked = true;
        headers.authorization = `Bearer ${revoked.accessToken}`;
        authNote = "auth=revoked session (GoTrue 403)";
      } else if (kind === 9) {
        const forged = await fake.mintSession(fixture.userA, "google");
        fake.sessions.delete(forged.accessToken);
        headers.authorization = `Bearer ${forged.accessToken}`;
        authNote = "auth=well-formed but unknown session token";
      } else if (kind === 10) {
        headers.authorization = `Bearer ${
          providerIdToken(fixture.userA, "https://evil.example")
        }`;
        authNote = "auth=jwt with foreign issuer";
      } else if (kind === 11) {
        headers.authorization = `Bearer ${
          providerIdToken(rng.uuid(), "https://accounts.google.com")
        }`;
        authNote = "auth=google id token for unknown subject";
      } else {
        authKind = "other_user";
        session = fixture.sessionB;
        headers.authorization = `Bearer ${fixture.sessionB.accessToken}`;
        authNote = "auth=session of ANOTHER user";
      }
      break;
    }

    case "path": {
      const kind = rng.int(0, 27);
      const id = fixture.target.id;
      if (kind === 0) {
        segment = id.toUpperCase();
        pathNote = "path=uppercase uuid";
      } else if (kind === 1) {
        segment = encodeURIComponent(id).replace(/-/g, "%2D");
        pathNote = "path=percent-encoded uuid";
      } else if (kind === 2) {
        segment = "00000000-0000-0000-0000-000000000000";
        pathNote = "path=nil uuid";
      } else if (kind === 3) {
        segment = "ffffffff-ffff-ffff-ffff-ffffffffffff";
        pathNote = "path=max uuid";
      } else if (kind === 4) {
        segment = id.replace(/-/g, "");
        pathNote = "path=uuid without hyphens";
      } else if (kind === 5) {
        segment = `{${id}}`;
        pathNote = "path=braced uuid";
      } else if (kind === 6) {
        segment = id.slice(0, rng.int(1, 35));
        pathNote = "path=truncated uuid";
      } else if (kind === 7) {
        segment = `${id}${chars(rng, "0123456789abcdef", rng.int(1, 8))}`;
        pathNote = "path=uuid with trailing hex";
      } else if (kind === 8) {
        segment = `${id.slice(0, 14)}${pick(rng, ["0", "9", "a", "f"])}${
          id.slice(15)
        }`;
        pathNote = "path=uuid with version nibble outside 1-8";
      } else if (kind === 9) {
        segment = `${id.slice(0, 19)}${pick(rng, ["0", "7", "c", "f"])}${
          id.slice(20)
        }`;
        pathNote = "path=uuid with variant nibble outside 8-b";
      } else if (kind === 10) {
        segment = `%E0%A4%A`;
        pathNote = "path=malformed percent escape";
      } else if (kind === 11) {
        segment = `%${chars(rng, "0123456789abcdef", 2)}${id}`;
        pathNote = "path=leading percent byte";
      } else if (kind === 12) {
        segment = `${id}%00`;
        pathNote = "path=uuid + %00";
      } else if (kind === 13) {
        segment = encodeURIComponent(`' or 1=1 --`);
        pathNote = "path=sql injection";
      } else if (kind === 14) {
        segment = `..%2F..%2F${id}`;
        pathNote = "path=encoded traversal";
      } else if (kind === 15) {
        segment = encodeURIComponent(
          Array.from(
            { length: rng.int(1, 12) },
            () => pick(rng, [..."日本語한국어😀é"]),
          ).join(""),
        );
        pathNote = "path=unicode";
      } else if (kind === 16) {
        segment = chars(
          rng,
          "abcdefghijklmnopqrstuvwxyz0123456789-",
          rng.int(1, 64),
        );
        pathNote = "path=random slug";
      } else if (kind === 17) {
        segment = chars(rng, "0123456789abcdef-", 36);
        pathNote = "path=random 36 hex/hyphen chars";
      } else if (kind === 18) {
        segment = "a".repeat(rng.int(1000, 8000));
        pathNote = "path=very long segment";
      } else if (kind === 19) {
        suffix = pick(rng, [
          "/finalize/",
          "/FINALIZE",
          "/finalise",
          "/finalize/extra",
          "",
          "/release",
          "/consume",
        ]);
        pathNote = `path=suffix ${suffix || "(none)"}`;
      } else if (kind === 20) {
        segment = "";
        pathNote = "path=empty segment (//finalize)";
      } else if (kind === 21) {
        prefix = pick(rng, [
          "/functions/v1/api/v1/v1",
          "/v1/x/v1",
          "/functions/v1/api",
        ]);
        pathNote = `path=prefix ${prefix}`;
      } else if (kind === 22) {
        suffix = `/finalize/v1/`;
        pathNote = "path=trailing /v1/ (lastIndexOf normalisation)";
      } else if (kind === 23) {
        segment = `${id}%2Ffinalize`;
        suffix = "";
        pathNote = "path=encoded slash swallowing /finalize";
      } else if (kind === 24) {
        segment = fixture.permitB.id;
        pathNote = "path=another user's permit id";
      } else if (kind === 25) {
        segment = rng.uuid();
        pathNote = "path=random unknown uuid";
      } else if (kind === 26) {
        segment = `${id.slice(0, 8).toUpperCase()}${id.slice(8)}`;
        pathNote = "path=mixed-case uuid";
      } else {
        segment = encodeURIComponent(`${id} `);
        pathNote = "path=uuid + encoded trailing space";
      }
      break;
    }

    case "body": {
      const kind = rng.int(0, 24);
      outcome = null;
      if (kind === 0) {
        bodyValue = { outcome: "scored" };
        bodyNote = "body=outcome scored (forbidden here)";
      } else if (kind === 1) {
        bodyValue = { outcome: "expired" };
        bodyNote = "body=outcome expired";
      } else if (kind === 2) {
        bodyValue = { outcome: pick(rng, RELEASABLE_OUTCOMES).toUpperCase() };
        bodyNote = "body=outcome uppercase";
      } else if (kind === 3) {
        bodyValue = {
          outcome: `${pick(rng, RELEASABLE_OUTCOMES)}${
            pick(rng, [" ", "\n", "\u0000", "\u200b"])
          }`,
        };
        bodyNote = "body=outcome with trailing control/space";
      } else if (kind === 4) {
        bodyValue = {
          outcome: pick(rng, [null, 1, true, [], {}, ["cancelled"], {
            v: "cancelled",
          }]),
        };
        bodyNote = "body=outcome non-string";
      } else if (kind === 5) {
        bodyValue = {};
        bodyNote = "body=missing outcome";
      } else if (kind === 6) {
        outcome = pick(rng, RELEASABLE_OUTCOMES);
        const rid = pick(rng, ["", 0, false, rng.uuid(), {}, [], "null", 1.5]);
        bodyValue = { outcome, ratingId: rid };
        bodyNote = `body=ratingId ${JSON.stringify(rid)} (must be null)`;
      } else if (kind === 7) {
        body = jsonBody({ outcome: "cancelled" }).slice(0, rng.int(1, 20));
        bodyNote = "body=truncated json";
      } else if (kind === 8) {
        body = `{"outcome": "cancelled",}`;
        bodyNote = "body=trailing comma";
      } else if (kind === 9) {
        body = `{'outcome': 'cancelled'}`;
        bodyNote = "body=single quotes";
      } else if (kind === 10) {
        body = `\ufeff${jsonBody({ outcome: "cancelled" })}`;
        bodyNote = "body=BOM prefix";
      } else if (kind === 11) {
        body = pick(rng, [
          `["cancelled"]`,
          `"cancelled"`,
          `42`,
          `null`,
          `true`,
        ]);
        bodyNote = `body=non-object json ${body}`;
      } else if (kind === 12) {
        body = "";
        bodyNote = "body=empty string";
      } else if (kind === 13) {
        body = undefined;
        bodyNote = "body=absent";
      } else if (kind === 14) {
        const depth = rng.int(50, 2000);
        body = `${"[".repeat(depth)}${"]".repeat(depth)}`;
        bodyNote = `body=nested arrays depth ${depth}`;
      } else if (kind === 15) {
        outcome = pick(rng, RELEASABLE_OUTCOMES);
        body = `{"outcome":"scored","outcome":${JSON.stringify(outcome)}}`;
        bodyNote = "body=duplicate outcome keys (last wins)";
      } else if (kind === 16) {
        outcome = pick(rng, RELEASABLE_OUTCOMES);
        body =
          `{"__proto__":{"outcome":"scored"},"constructor":{"prototype":1},"outcome":${
            JSON.stringify(outcome)
          }}`;
        bodyNote = "body=prototype-pollution keys";
      } else if (kind === 17) {
        outcome = pick(rng, RELEASABLE_OUTCOMES);
        const pad = "x".repeat(MAX_JSON_BODY_BYTES - 200);
        body = `{"pad":"${pad}","outcome":${JSON.stringify(outcome)}}`;
        bodyNote = "body=just under 5 MB, valid";
      } else if (kind === 18) {
        body = new Uint8Array(MAX_JSON_BODY_BYTES + rng.int(1, 4096)).fill(
          0x20,
        );
        bodyNote = "body=over 5 MB streamed (no content-length)";
      } else if (kind === 19) {
        headers["content-length"] = String(
          MAX_JSON_BODY_BYTES + rng.int(1, 1_000_000),
        );
        bodyNote = "body=declared content-length > 5 MB";
      } else if (kind === 20) {
        headers["content-length"] = pick(rng, [
          "abc",
          "-1",
          "1e7",
          "0x10",
          "Infinity",
          "NaN",
          "9007199254740993",
        ]);
        outcome = pick(rng, RELEASABLE_OUTCOMES);
        bodyValue = { outcome };
        bodyNote = `body=content-length ${headers["content-length"]}`;
      } else if (kind === 21) {
        body = new TextEncoder().encode(jsonBody({ outcome: "cancelled" })).map(
          (b) => (b > 0x20 ? b ^ 0x80 : b),
        );
        bodyNote = "body=high-bit garbage bytes";
      } else if (kind === 22) {
        body = `{"outcome":"cancel\\u006ced"}`;
        outcome = "cancelled";
        bodyNote = "body=outcome via unicode escape";
      } else if (kind === 23) {
        bodyValue = {
          outcome: "cancelled".normalize("NFKD").replace("l", "\u{217C}"),
        };
        bodyNote = "body=outcome with unicode homoglyph";
      } else {
        outcome = pick(rng, RELEASABLE_OUTCOMES);
        const filler: Record<string, unknown> = { outcome };
        for (let k = 0; k < rng.int(100, 2000); k++) filler[`k${k}`] = k;
        bodyValue = filler;
        bodyNote = "body=thousands of extra keys";
      }
      break;
    }

    case "state": {
      if (stateNote === "target=other user's permit") {
        segment = fixture.permitB.id;
      } else if (stateNote === "target=nonexistent id") {
        segment = rng.uuid();
      } else if (
        targetState.status !== "reserved" && rng.next() < 0.5 &&
        targetState.outcome !== "scored" && targetState.outcome !== "expired"
      ) {
        outcome = targetState.outcome;
        bodyValue = { outcome };
        bodyNote = `body={outcome:${outcome}} (same as stored → idempotent)`;
      }
      break;
    }

    case "fault": {
      const target = pick(
        rng,
        [
          "gotrue_user",
          "pg_select",
          "pg_update",
          "rpc_access",
        ] as FaultTarget[],
      );
      const mode = pick(
        rng,
        target === "gotrue_user"
          ? AUTH_FAULT_MODES
          : target === "rpc_access"
          ? [...PG_WRITE_FAULT_MODES, "http200_empty"]
          : target === "pg_update"
          ? PG_WRITE_FAULT_MODES
          : PG_FAULT_MODES,
      );
      fault = { target, mode };
      if (target === "rpc_access" && rng.next() < 0.3) {
        // idempotent replay path also calls access_state
        const o = pick(rng, RELEASABLE_OUTCOMES);
        fake.permits.splice(fake.permits.indexOf(fixture.target), 1);
        fixture.target = fake.addPermit(fixture.userA, "finalized", o, {
          id: fixture.target.id,
        });
        outcome = o;
        bodyValue = { outcome };
        bodyNote = `body={outcome:${o}} (same as stored → idempotent)`;
        stateNote = `target=finalized/${o}`;
      }
      pathNote = `fault=${target}:${mode}`;
      break;
    }

    case "headers": {
      const kind = rng.int(0, 8);
      if (kind === 0) {
        clientRequestId = null;
        headers["x-request-id"] = pick(rng, [
          "short",
          "a".repeat(65),
          "has space 12345",
          "semi;colon;123",
          "ünïcödé-12345",
          "<script>alert(1)</script>",
          "\t\t\t\t\t\t\t\t",
        ]);
        pathNote = "headers=ill-formed x-request-id (must be replaced)";
      } else if (kind === 1) {
        headers["x-forwarded-for"] = `${ip(rng)}, ${ip(rng)}, ${ip(rng)}`;
        pathNote = "headers=multi-hop x-forwarded-for";
      } else if (kind === 2) {
        headers["cf-connecting-ip"] = ip(rng);
        pathNote = "headers=cf-connecting-ip";
      } else if (kind === 3) {
        headers[`x-${chars(rng, "abcdefghijklmnopqrstuvwxyz", 8)}`] = chars(
          rng,
          HEADER_CHARS,
          rng.int(4000, 8000),
        );
        pathNote = "headers=8 KB custom header";
      } else if (kind === 4) {
        headers.accept = pick(rng, ["text/html", "*/*", "application/xml", ""]);
        pathNote = `headers=accept ${headers.accept || "(empty)"}`;
      } else if (kind === 5) {
        headers["x-forwarded-for"] = pick(rng, [
          "",
          " , , ",
          "not-an-ip",
          "::1",
        ]);
        pathNote = "headers=degenerate x-forwarded-for";
      } else if (kind === 6) {
        headers["content-type"] = "";
        pathNote = "headers=empty content-type";
      } else if (kind === 7) {
        headers.apikey = chars(rng, HEADER_CHARS, 40);
        headers.prefer = "return=representation";
        pathNote = "headers=stray PostgREST headers";
      } else {
        headers["x-request-id"] = fixture.sessionA.accessToken.slice(0, 64)
          .replace(/[^A-Za-z0-9._-]/g, "x");
        clientRequestId = headers["x-request-id"];
        pathNote = "headers=x-request-id at 64-char max";
      }
      break;
    }
  }

  if (session && authKind !== "invalid" && !headers.authorization) {
    headers.authorization = `Bearer ${session.accessToken}`;
  }
  if (category === "happy" && rng.next() < 0.12) {
    // transitional provider-token bearer (still authenticated by index.ts)
    authKind = "provider_valid";
    headers.authorization = `Bearer ${
      providerIdToken(
        fixture.userA,
        fixture.sessionA.provider === "apple"
          ? "https://appleid.apple.com"
          : "https://accounts.google.com",
      )
    }`;
    authNote =
      `auth=${fixture.sessionA.provider} id token for user A (transitional)`;
    // Auth faults on this exchange are exercised deterministically (every
    // mode) by the F1 test below rather than sampled here.
  }
  if (
    body === undefined && bodyValue !== undefined &&
    bodyNote !== "body=absent" && method !== "GET" && method !== "HEAD"
  ) {
    body = jsonBody(bodyValue);
  }
  if (method === "GET" || method === "HEAD") body = undefined;
  if (bodyNote === "body=absent") body = undefined;

  const spec: EdgeRequestSpec = {
    method,
    pathname: `${prefix}/analysis-permits/${segment}${suffix}`,
    query,
    headers,
    body,
  };
  const { oracle, target, outcome: effectiveOutcome } = oracleFor(
    fake,
    fixture,
    spec,
    authKind,
    fault,
  );
  const description = [
    stateNote,
    authNote,
    pathNote,
    bodyNote,
    query ? `query=${query}` : "",
    clientRequestId ? "x-request-id=client" : "",
  ]
    .filter(Boolean)
    .join("; ");
  return {
    iteration,
    seed,
    category,
    description,
    spec,
    oracle,
    target,
    targetIdInPath: segment,
    outcome: effectiveOutcome,
    session,
    clientRequestId,
    fault,
    reservedBefore,
    replayExpected: oracle.writes === "finalize" ? [200] : null,
  };
}

// ── Execution + verification ─────────────────────────────────────────────────

interface IterationResult {
  i: number;
  seed: number;
  category: Category;
  description: string;
  expected: number[];
  status: number;
  code: string | null;
  ms: number;
  verdict: "HELD" | "BROKEN";
  problems: string[];
  requestId: string | null;
  upstream: string[];
  replayStatus?: number;
}

function summarizeSpec(spec: EdgeRequestSpec) {
  const bodyLength = spec.body === undefined
    ? 0
    : typeof spec.body === "string"
    ? spec.body.length
    : spec.body.byteLength;
  const bodyPreview = spec.body === undefined
    ? null
    : typeof spec.body === "string"
    ? spec.body.slice(0, 200)
    : `<${spec.body.byteLength} bytes>`;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.headers)) {
    headers[k] = k === "authorization"
      ? `${v.slice(0, 12)}…(${v.length})`
      : v.length > 120
      ? `${v.slice(0, 120)}…(${v.length})`
      : v;
  }
  return {
    method: spec.method,
    pathname: spec.pathname.length > 200
      ? `${spec.pathname.slice(0, 200)}…(${spec.pathname.length})`
      : spec.pathname,
    query: spec.query ?? "",
    headers,
    bodyLength,
    bodyPreview,
  };
}

async function runScenario(
  handler: (request: Request) => Promise<Response>,
  fake: FinalizeFake,
  scenario: Scenario,
): Promise<{ result: IterationResult; audit: ResponseAudit; logs: string[] }> {
  const problems: string[] = [];
  const before = fake.snapshot();
  fake.calls = [];
  fake.faults = scenario.fault ? [scenario.fault] : [];
  const accessLines: string[] = [];
  const restore = captureAccessLog((line) => accessLines.push(line));
  const t0 = performance.now();
  let audit: ResponseAudit;
  let logs: string[] = [];
  try {
    const captured = await captureConsole(async () => {
      const response = await handler(buildRequest(scenario.spec));
      return await auditResponse(response);
    });
    audit = captured.value;
    logs = [...captured.lines, ...accessLines];
  } finally {
    restore();
  }
  const ms = Math.round((performance.now() - t0) * 100) / 100;
  const after = fake.snapshot();
  const { oracle } = scenario;

  // 1. status per oracle
  if (!oracle.statuses.includes(audit.status)) {
    problems.push(
      `status ${audit.status} not in oracle ${JSON.stringify(oracle.statuses)}`,
    );
  }
  // 2. bad input → only the allowed 4xx family (never a 5xx, never a 2xx)
  if (
    oracle.statuses.every((s) => s >= 400 && s < 500) &&
    !BAD_INPUT_STATUSES.has(audit.status) && audit.status !== 409
  ) {
    problems.push(`bad input answered ${audit.status}`);
  }
  // 3. generic 5xx / no leaks
  if (audit.status >= 500) {
    if (audit.generic5xx !== true) {
      problems.push(`5xx body not generic: ${audit.bodyText.slice(0, 200)}`);
    }
    if (audit.status !== 503 && audit.status !== 500) {
      problems.push(`unexpected 5xx status ${audit.status}`);
    }
  }
  if (
    audit.leaks.length > 0 &&
    !(audit.status === 404 &&
      audit.errorMessage?.startsWith("Unknown endpoint"))
  ) {
    problems.push(
      `body leaks ${audit.leaks.join(",")}: ${audit.bodyText.slice(0, 200)}`,
    );
  }
  if (
    audit.status === 404 &&
    audit.errorMessage?.startsWith("Unknown endpoint") &&
    /\bat\s+\S+\s+\(.+:\d+:\d+\)/.test(audit.bodyText)
  ) {
    problems.push("Unknown endpoint body carries a stack frame");
  }
  // 4. request id
  if (!audit.requestId) {
    problems.push("missing x-request-id");
  } else if (
    scenario.clientRequestId && REQUEST_ID_RE.test(scenario.clientRequestId)
  ) {
    if (audit.requestId !== scenario.clientRequestId) {
      problems.push(
        `well-formed client x-request-id not echoed (${audit.requestId})`,
      );
    }
  } else if (!UUID_V4_RE.test(audit.requestId)) {
    problems.push(`minted x-request-id is not a uuid: ${audit.requestId}`);
  }
  if (
    scenario.spec.headers["x-request-id"] &&
    !REQUEST_ID_RE.test(scenario.spec.headers["x-request-id"].trim()) &&
    audit.requestId === scenario.spec.headers["x-request-id"]
  ) {
    problems.push("ill-formed client x-request-id was echoed");
  }
  // 5. JSON envelope + security headers on every JSON answer
  if (scenario.spec.method !== "HEAD") {
    if (!(audit.contentType ?? "").includes("application/json")) {
      problems.push(`content-type ${audit.contentType}`);
    }
    if (!audit.body) problems.push("body is not a JSON object");
  }
  if (audit.status >= 400 && audit.body) {
    const err = audit.body.error;
    if (!err || typeof err !== "object") {
      problems.push("error envelope missing");
    }
    if (oracle.code && audit.errorCode !== oracle.code) {
      problems.push(`error.code ${audit.errorCode} ≠ ${oracle.code}`);
    }
  }
  // 6. write discipline
  const mutated = fake.calls.filter((c) => c.method === "PATCH").reduce(
    (s, c) => s + (c.mutated ?? 0),
    0,
  );
  if (
    oracle.writes === "none" || (audit.status !== 200 && !oracle.writeThen5xx)
  ) {
    if (before !== after) {
      problems.push("permit table changed on a non-success path");
    }
    if (mutated > 0) {
      problems.push(`${mutated} row(s) mutated on a non-success path`);
    }
  } else if (scenario.target) {
    const rowAfter = fake.permits.find((p) => p.id === scenario.target!.id);
    if (!rowAfter) problems.push("target row vanished");
    else {
      if (rowAfter.status !== "finalized") {
        problems.push(`target status ${rowAfter.status} after success`);
      }
      if (rowAfter.outcome !== scenario.outcome) {
        problems.push(
          `target outcome ${rowAfter.outcome} ≠ ${scenario.outcome}`,
        );
      }
    }
    const others = (rows: string) =>
      JSON.parse(rows).filter((r: StressPermit) =>
        r.id !== scenario.target!.id
      );
    if (JSON.stringify(others(before)) !== JSON.stringify(others(after))) {
      problems.push("a non-target row changed");
    }
    if (mutated !== 1) {
      problems.push(`expected exactly 1 mutated row, saw ${mutated}`);
    }
  }
  // 7. 200 body contract
  if (audit.status === 200 && audit.body) {
    const permit = audit.body.permit as Record<string, unknown> | undefined;
    const access = audit.body.access as Record<string, unknown> | undefined;
    if (!permit || !access) problems.push("200 body lacks permit/access");
    else {
      if (scenario.target && permit.id !== scenario.target.id) {
        problems.push(`permit.id ${permit.id}`);
      }
      if (permit.status !== "finalized") {
        problems.push(`permit.status ${permit.status}`);
      }
      if (permit.outcome !== scenario.outcome) {
        problems.push(`permit.outcome ${permit.outcome}`);
      }
      if (permit.accessSource !== "free") {
        problems.push(`permit.accessSource ${permit.accessSource}`);
      }
      if (
        typeof permit.reservedAt !== "string" ||
        typeof permit.expiresAt !== "string"
      ) problems.push("permit timestamps missing");
      const fr = access.freeRatings as Record<string, number> | undefined;
      if (!fr) problems.push("access.freeRatings missing");
      else {
        const userId = scenario.target?.user_id ?? scenario.session?.userId ??
          "";
        const reservedNow = Math.min(reservedCount(fake, userId), fr.remaining);
        if (fr.reserved !== reservedNow) {
          problems.push(
            `access.freeRatings.reserved ${fr.reserved} ≠ live ${reservedNow}`,
          );
        }
        if (
          fr.limit !== 2 || fr.remaining !== fr.limit - fr.used ||
          fr.availableToReserve !== fr.remaining - fr.reserved
        ) problems.push("access arithmetic broken");
      }
    }
  }
  // 8. logs never carry the bearer
  const tokens = [scenario.spec.headers.authorization ?? ""].filter((t) =>
    t.length > 20
  ).map((t) => t.replace(/^Bearer\s+/i, ""));
  for (const line of logs) {
    for (const token of tokens) {
      if (token && line.includes(token)) {
        problems.push("bearer token appeared in function logs");
      }
    }
    if (
      scenario.target && scenario.target.user_id &&
      line.includes(scenario.target.user_id) && line.startsWith("log ")
    ) problems.push("user id appeared in the access log");
  }

  const result: IterationResult = {
    i: scenario.iteration,
    seed: scenario.seed,
    category: scenario.category,
    description: scenario.description,
    expected: oracle.statuses,
    status: audit.status,
    code: audit.errorCode,
    ms,
    verdict: problems.length === 0 ? "HELD" : "BROKEN",
    problems,
    requestId: audit.requestId,
    upstream: fake.calls.map((c) =>
      `${c.method} ${
        new URL(c.url).pathname.replace(SUPABASE_URL, "")
      } → ${c.status}${
        c.mutated !== undefined ? ` (mutated ${c.mutated})` : ""
      }`
    ),
  };

  // 9. duplicate delivery: a success (or a post-commit 503) replayed verbatim must be 200 with no new mutation
  if (
    (audit.status === 200 && oracle.writes === "finalize") ||
    oracle.writeThen5xx
  ) {
    fake.calls = [];
    fake.faults = [];
    const restore2 = captureAccessLog(() => undefined);
    let replay: ResponseAudit;
    try {
      replay = (await captureConsole(async () =>
        auditResponse(await handler(buildRequest(scenario.spec)))
      )).value;
    } finally {
      restore2();
    }
    result.replayStatus = replay.status;
    if (replay.status !== 200) {
      problems.push(`replay of a committed release answered ${replay.status}`);
    }
    const replayMutated = fake.calls.filter((c) => c.method === "PATCH").reduce(
      (s, c) => s + (c.mutated ?? 0),
      0,
    );
    if (replayMutated > 0) {
      problems.push(`replay mutated ${replayMutated} row(s)`);
    }
    if (fake.calls.some((c) => c.method === "PATCH")) {
      problems.push(
        "replay issued a PATCH although the row was already settled",
      );
    }
    if (fake.snapshot() !== after) problems.push("replay changed the table");
    result.verdict = problems.length === 0 ? "HELD" : "BROKEN";
  }
  return { result, audit, logs };
}

// ── The campaign ─────────────────────────────────────────────────────────────

Deno.test(`stress fuzz: ${REPLAY.length ? `replay ${REPLAY.join(",")}` : `${STRESS_ITER} seeded requests`} against POST /v1/analysis-permits/:id/finalize (seed ${STRESS_SEED})`, () =>
  withStressHarness(async (h) => {
    const results: IterationResult[] = [];
    const failures: Array<
      IterationResult & {
        request: ReturnType<typeof summarizeSpec>;
        body: string;
        logs: string[];
      }
    > = [];
    const fiveXx: Array<
      {
        seed: number;
        i: number;
        description: string;
        status: number;
        body: string;
        generic: boolean | null;
        request: ReturnType<typeof summarizeSpec>;
        fault: Fault | null;
      }
    > = [];
    const t0 = performance.now();
    const heapBefore = Deno.memoryUsage();

    const seeds = REPLAY.length
      ? REPLAY
      : Array.from({ length: STRESS_ITER }, (_, i) =>
        iterationSeed(STRESS_SEED, i));
    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i];
      const scenario = await generate(h.fake, i, seed);
      const { result, audit, logs } = await runScenario(
        h.handler,
        h.fake,
        scenario,
      );
      results.push(result);
      if (audit.status >= 500) {
        fiveXx.push({
          seed,
          i,
          description: scenario.description,
          status: audit.status,
          body: audit.bodyText.slice(0, 400),
          generic: audit.generic5xx,
          request: summarizeSpec(scenario.spec),
          fault: scenario.fault,
        });
      }
      if (result.verdict === "BROKEN") {
        failures.push({
          ...result,
          request: summarizeSpec(scenario.spec),
          body: audit.bodyText.slice(0, 600),
          logs: logs.slice(0, 20),
        });
      }
    }
    const durationMs = Math.round(performance.now() - t0);
    const heapAfter = Deno.memoryUsage();

    const summary = {
      campaign: "stress_permits_finalize_fuzz",
      route: "POST /v1/analysis-permits/:id/finalize",
      seed: STRESS_SEED,
      iterations: results.length,
      replay: REPLAY,
      durationMs,
      heap: { before: heapBefore, after: heapAfter },
      verdicts: histogram(results.map((r) => r.verdict)),
      statuses: histogram(results.map((r) => r.status)),
      categories: histogram(results.map((r) => r.category)),
      statusByCategory: Object.fromEntries(
        Array.from(new Set(results.map((r) => r.category))).map((
          c,
        ) => [
          c,
          histogram(
            results.filter((r) => r.category === c).map((r) => r.status),
          ),
        ]),
      ),
      fiveXxCount: fiveXx.length,
      fiveXxAllGeneric: fiveXx.every((x) => x.generic === true),
      unexpected5xx: fiveXx.filter((x) => !x.fault).length,
      replays: histogram(
        results.filter((r) => r.replayStatus !== undefined).map((r) =>
          r.replayStatus!
        ),
      ),
      failingSeeds: failures.map((f) => f.seed),
      replayCommand: (seed: number) =>
        `STRESS_REPLAY=${seed} deno test -A --no-check --config deno.json stress_permits_finalize_fuzz.test.ts --filter "stress fuzz"`,
    };
    const replayCommands = failures.map((f) => summary.replayCommand(f.seed));
    const written = await writeJson("fuzz_results.json", {
      ...summary,
      replayCommand: summary.replayCommand(STRESS_SEED),
      replayCommands,
      results,
    });
    await writeJson("fuzz_failures.json", {
      count: failures.length,
      replayCommands,
      failures,
    });
    await writeJson("fuzz_5xx.json", {
      count: fiveXx.length,
      allGeneric: summary.fiveXxAllGeneric,
      unexpected: summary.unexpected5xx,
      entries: fiveXx,
    });
    console.log(
      `[stress fuzz] ${results.length} requests in ${durationMs} ms → ${
        JSON.stringify(summary.verdicts)
      } statuses=${
        JSON.stringify(summary.statuses)
      } 5xx=${fiveXx.length} (generic=${summary.fiveXxAllGeneric}, unexpected=${summary.unexpected5xx}) → ${written}`,
    );
    assert(
      results.length >= (REPLAY.length || STRESS_ITER),
      "every planned iteration ran",
    );
    assertEquals(
      failures.map((f) =>
        `seed ${f.seed} [${f.category}] ${f.description}: ${
          f.problems.join(" | ")
        }`
      ),
      [],
      `${failures.length} BROKEN iteration(s); replay with ${
        replayCommands[0] ?? "(none)"
      }`,
    );
  }));

// ── Duplicate delivery / concurrency (same permit, real handler, fake with latency) ──

interface Lane {
  lane: number;
  outcome: string;
  status: number;
  code: string | null;
  permitStatus?: unknown;
  permitOutcome?: unknown;
}

Deno.test(`stress fuzz C1–C6: concurrent duplicate/conflicting releases of ONE permit (${STRESS_ROUNDS} rounds × ${STRESS_BURST} lanes)`, () =>
  withStressHarness(async (h) => {
    const report: Array<Record<string, unknown>> = [];
    const problems: string[] = [];
    const restore = captureAccessLog(() => undefined);
    try {
      for (let r = 0; r < STRESS_ROUNDS; r++) {
        const seed = iterationSeed(STRESS_SEED ^ 0xc0ffee, r);
        const rng = new Prng(seed);
        h.fake.reset(seed, 3);
        const userId = rng.uuid();
        const session = await h.fake.mintSession(userId);
        const send = (permitId: string, outcome: string, laneIp: string) =>
          h.handler(
            buildRequest({
              method: "POST",
              pathname:
                `/functions/v1/api/v1/analysis-permits/${permitId}/finalize`,
              headers: {
                authorization: `Bearer ${session.accessToken}`,
                "content-type": "application/json",
                "x-forwarded-for": laneIp,
              },
              body: JSON.stringify({ outcome }),
            }),
          );
        const lanes = async (
          permitId: string,
          outcomes: string[],
        ): Promise<Lane[]> => {
          const { value } = await captureConsole(() =>
            Promise.all(
              outcomes.map(async (outcome, lane) => {
                const audit = await auditResponse(
                  await send(permitId, outcome, ip(rng)),
                );
                const permit = (audit.body?.permit ?? {}) as Record<
                  string,
                  unknown
                >;
                return {
                  lane,
                  outcome,
                  status: audit.status,
                  code: audit.errorCode,
                  permitStatus: permit.status,
                  permitOutcome: permit.outcome,
                };
              }),
            )
          );
          return value;
        };
        const mutatedTotal = () =>
          h.fake.calls.filter((c) => c.method === "PATCH").reduce(
            (s, c) => s + (c.mutated ?? 0),
            0,
          );

        // C1: identical duplicates
        const p1 = h.fake.addPermit(userId);
        h.fake.calls = [];
        const same = pick(rng, RELEASABLE_OUTCOMES);
        const c1 = await lanes(
          p1.id,
          Array.from({ length: STRESS_BURST }, () => same),
        );
        const c1Row = h.fake.permits.find((p) => p.id === p1.id)!;
        const c1ok = c1.every((l) =>
          l.status === 200 && l.permitStatus === "finalized" &&
          l.permitOutcome === same
        ) && mutatedTotal() === 1 && c1Row.status === "finalized" &&
          c1Row.outcome === same;
        if (!c1ok) {
          problems.push(`round ${r} C1: ${
            JSON.stringify(histogram(c1.map((l) => l.status)))
          } mutated=${mutatedTotal()} row=${c1Row.status}/${c1Row.outcome}`);
        }
        report.push({
          round: r,
          seed,
          scenario: "C1 identical duplicates",
          outcome: same,
          statuses: histogram(c1.map((l) =>
            l.status
          )),
          mutated: mutatedTotal(),
          row: `${c1Row.status}/${c1Row.outcome}`,
        });

        // C2: conflicting outcomes
        const p2 = h.fake.addPermit(userId);
        h.fake.calls = [];
        const mixed = Array.from({ length: STRESS_BURST }, () =>
          pick(rng, RELEASABLE_OUTCOMES));
        const c2 = await lanes(p2.id, mixed);
        const c2Row = h.fake.permits.find((p) =>
          p.id === p2.id
        )!;
        const winners = c2.filter((l) =>
          l.status === 200
        );
        const losers = c2.filter((l) => l.status === 409);
        const c2ok = c2.every((l) => l.status === 200 || l.status === 409) &&
          winners.length >= 1 &&
          winners.every((l) =>
            l.outcome === c2Row.outcome && l.permitOutcome === c2Row.outcome
          ) &&
          losers.every((l) =>
            l.outcome !== c2Row.outcome && l.code === CONFLICT
          ) &&
          mutatedTotal() === 1 &&
          c2Row.status === "finalized";
        if (!c2ok) {
          problems.push(`round ${r} C2: ${
            JSON.stringify(histogram(c2.map((l) => `${l.status}/${l.outcome}`)))
          } mutated=${mutatedTotal()} row=${c2Row.status}/${c2Row.outcome}`);
        }
        report.push({
          round: r,
          seed,
          scenario: "C2 conflicting outcomes",
          statuses: histogram(c2.map((l) =>
            `${l.status}:${l.outcome}`
          )),
          mutated: mutatedTotal(),
          row: `${c2Row.status}/${c2Row.outcome}`,
        });

        // C3: response lost after commit → verbatim replay heals, no second write
        const p3 = h.fake.addPermit(userId);
        const o3 = pick(rng, RELEASABLE_OUTCOMES);
        h.fake.faults = [{
          target: "rpc_access",
          mode: pick(rng, PG_FAULT_MODES),
        }];
        h.fake.calls = [];
        const first = (await captureConsole(async () =>
          auditResponse(await send(p3.id, o3, ip(rng)))
        )).value;
        const firstMutated = mutatedTotal();
        h.fake.calls = [];
        const second = (await captureConsole(async () =>
          auditResponse(await send(p3.id, o3, ip(rng)))
        )).value;
        const c3Row = h.fake.permits.find((p) =>
          p.id === p3.id
        )!;
        const c3ok = first.status === 503 && first.generic5xx === true &&
          firstMutated === 1 && second.status === 200 && mutatedTotal() === 0 &&
          !h.fake.calls.some((c) =>
            c.method === "PATCH"
          ) &&
          c3Row.status === "finalized" && c3Row.outcome === o3;
        if (!c3ok) {
          problems.push(
            `round ${r} C3: first=${first.status} (generic=${first.generic5xx}, mutated=${firstMutated}) replay=${second.status} (patches=${
              h.fake.calls.filter((c) => c.method === "PATCH").length
            }) row=${c3Row.status}/${c3Row.outcome}`,
          );
        }
        report.push({
          round: r,
          seed,
          scenario: "C3 post-commit 503 then replay",
          first: first.status,
          replay: second.status,
          row: `${c3Row.status}/${c3Row.outcome}`,
        });

        // C4: release racing a scored consumption that commits between SELECT and UPDATE
        const p4 = h.fake.addPermit(userId);
        const o4 = pick(rng, RELEASABLE_OUTCOMES);
        h.fake.beforePatch = () => {
          p4.status = "finalized";
          p4.outcome = "scored";
          h.fake.shots.push({ user_id: userId, result_kind: "scored" });
        };
        h.fake.calls = [];
        const c4 = (await captureConsole(async () =>
          auditResponse(await send(p4.id, o4, ip(rng)))
        )).value;
        const c4Row = h.fake.permits.find((p) => p.id === p4.id)!;
        const c4ok = c4.status === 409 && c4.errorCode === CONFLICT &&
          c4Row.status === "finalized" && c4Row.outcome === "scored" &&
          mutatedTotal() === 0 && h.fake.beforePatch === null;
        if (!c4ok) {
          problems.push(
            `round ${r} C4: status=${c4.status} code=${c4.errorCode} row=${c4Row.status}/${c4Row.outcome} mutated=${mutatedTotal()}`,
          );
        }
        report.push({
          round: r,
          seed,
          scenario: "C4 release vs concurrent scored consume",
          status: c4.status,
          code: c4.errorCode,
          row: `${c4Row.status}/${c4Row.outcome}`,
          mutated: mutatedTotal(),
        });
      }

      // C5 (once): PostgREST socket dead for the whole request. supabase-js retries
      // the SELECT with 1 s/2 s/4 s backoff, so the route must still answer a
      // generic 503 (bounded, ≈7 s) and leave the permit untouched.
      const seed5 = iterationSeed(STRESS_SEED ^ 0xc0ffee, STRESS_ROUNDS);
      const rng5 = new Prng(seed5);
      h.fake.reset(seed5, 0);
      const user5 = rng5.uuid();
      const session5 = await h.fake.mintSession(user5);
      const p5 = h.fake.addPermit(user5);
      h.fake.faults = [{ target: "pg_select", mode: "throw_sticky" }];
      h.fake.calls = [];
      const t5 = performance.now();
      const c5 = (
        await captureConsole(async () =>
          auditResponse(
            await h.handler(
              buildRequest({
                method: "POST",
                pathname:
                  `/functions/v1/api/v1/analysis-permits/${p5.id}/finalize`,
                headers: {
                  authorization: `Bearer ${session5.accessToken}`,
                  "content-type": "application/json",
                  "x-forwarded-for": ip(rng5),
                },
                body: JSON.stringify({
                  outcome: pick(rng5, RELEASABLE_OUTCOMES),
                }),
              }),
            ),
          )
        )
      ).value;
      const c5Ms = Math.round(performance.now() - t5);
      const c5Attempts = h.fake.calls.filter((c) =>
        c.method === "GET" && String(c.status).startsWith("fault")
      ).length;
      const c5Mutated = h.fake.calls.filter((c) =>
        c.method === "PATCH"
      ).reduce((s, c) => s + (c.mutated ?? 0), 0);
      const c5Row = h.fake.permits.find((p) =>
        p.id === p5.id
      )!;
      const c5ok = c5.status === 503 && c5.generic5xx === true &&
        c5.leaks.length === 0 && REQUEST_ID_RE.test(c5.requestId ?? "") &&
        c5Row.status === "reserved" && c5Row.outcome === null &&
        c5Mutated === 0 && c5Attempts >= 2 && c5Ms < 15_000;
      if (!c5ok) {
        problems.push(
          `C5: status=${c5.status} generic=${c5.generic5xx} attempts=${c5Attempts} ${c5Ms}ms row=${c5Row.status}/${c5Row.outcome} mutated=${c5Mutated} leaks=${
            c5.leaks.join("; ")
          }`,
        );
      }
      report.push({
        round: -1,
        seed: seed5,
        scenario: "C5 dead PostgREST socket on SELECT",
        status: c5.status,
        attempts: c5Attempts,
        ms: c5Ms,
        row: `${c5Row.status}/${c5Row.outcome}`,
        mutated: c5Mutated,
      });
      h.fake.faults = [];

      // C6 (once): one user hammers the route past the general per-user budget
      // (240/60 s). Requests past the budget must be 429 + Retry-After, never
      // reach PostgREST, and never mutate; the permits they named stay reserved.
      const seed6 = iterationSeed(STRESS_SEED ^ 0xc0ffee, STRESS_ROUNDS + 1);
      const rng6 = new Prng(seed6);
      h.fake.reset(seed6, 0);
      const user6 = rng6.uuid();
      const session6 = await h.fake.mintSession(user6);
      const budget = 240;
      const overshoot = 12;
      const permits6 = Array.from(
        { length: budget + overshoot },
        () => h.fake.addPermit(user6),
      );
      // fixed-window buckets are minute-aligned; do not straddle a boundary.
      const msToBoundary = 60_000 - (Date.now() % 60_000);
      if (msToBoundary < 5_000) await sleep(msToBoundary + 50);
      h.fake.calls = [];
      const c6: Array<
        {
          status: number;
          retryAfter: string | null;
          code: string | null;
          leaks: string[];
          requestId: string | null;
        }
      > = [];
      await captureConsole(async () => {
        for (const permit of permits6) {
          const audit = await auditResponse(
            await h.handler(
              buildRequest({
                method: "POST",
                pathname:
                  `/functions/v1/api/v1/analysis-permits/${permit.id}/finalize`,
                headers: {
                  authorization: `Bearer ${session6.accessToken}`,
                  "content-type": "application/json",
                  "x-forwarded-for": ip(rng6),
                },
                body: JSON.stringify({
                  outcome: pick(rng6, RELEASABLE_OUTCOMES),
                }),
              }),
            ),
          );
          c6.push({
            status: audit.status,
            retryAfter: audit.retryAfter,
            code: audit.errorCode,
            leaks: audit.leaks,
            requestId: audit.requestId,
          });
        }
      });
      const c6Mutated = h.fake.calls.filter((c) => c.method === "PATCH").reduce(
        (s, c) => s + (c.mutated ?? 0),
        0,
      );
      const c6Limited = c6.filter((r) => r.status === 429);
      const c6Ok = c6.filter((r) => r.status === 200);
      const stillReserved = permits6.slice(budget).filter((p) =>
        p.status === "reserved" && p.outcome === null
      ).length;
      const c6ok = c6Ok.length === budget &&
        c6Limited.length === overshoot &&
        c6.slice(0, budget).every((r) =>
          r.status === 200
        ) &&
        c6.slice(budget).every((r) =>
          r.status === 429 && r.code === "rate_limited" &&
          /^\d+$/.test(r.retryAfter ?? "") && r.leaks.length === 0 &&
          REQUEST_ID_RE.test(r.requestId ?? "")
        ) &&
        c6Mutated === budget &&
        stillReserved === overshoot &&
        h.fake.calls.filter((c) => c.method === "PATCH").length === budget;
      if (!c6ok) {
        problems.push(`C6: ${
          JSON.stringify(histogram(c6.map((r) => r.status)))
        } mutated=${c6Mutated} patches=${
          h.fake.calls.filter((c) => c.method === "PATCH").length
        } stillReserved=${stillReserved}/${overshoot} retryAfter=${
          c6Limited[0]?.retryAfter ?? "n/a"
        }`);
      }
      report.push({
        round: -1,
        seed: seed6,
        scenario: "C6 per-user budget exhausted",
        statuses: histogram(c6.map((r) =>
          r.status
        )),
        mutated: c6Mutated,
        stillReserved,
        retryAfter: c6Limited[0]?.retryAfter ?? null,
      });
    } finally {
      restore();
    }
    const path = await writeJson("concurrency_results.json", {
      seed: STRESS_SEED,
      rounds: STRESS_ROUNDS,
      burst: STRESS_BURST,
      problems,
      report,
    });
    console.log(
      `[stress fuzz C1–C6] ${report.length} scenarios, ${problems.length} problem(s) → ${path}`,
    );
    assertEquals(problems, []);
  }));

// ─────────────────────────────────────────────────────────────────────────────
// F1 — transitional provider-token bearer while Supabase Auth is DOWN.
//
// Found by the 3000-iteration campaign (seed 2656965708, then generalised to
// every fault mode). The route header promises "401/403 = verdict on the
// credential, 5xx = retryable unavailable", and the session-bearer path keeps
// that promise (verifyAccessToken → 503). The transitional branch folds every
// signInWithIdToken error — including a socket failure or an Auth 5xx — into
// 401 "The identity token could not be verified.", i.e. an Auth outage is
// reported to a pre-contract app build as a refused credential (which those
// builds treat as sign-out). No write is at stake (auth precedes the permit
// read), so the residual assertions (generic body, request id, no PostgREST
// traffic) pin what DOES hold. Runs every fault mode deterministically so the
// finding is a fixed test, not a sampled one.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("stress fuzz F1: transitional provider-token bearer during an Auth outage is a retryable 503, not a 401 verdict", () =>
  withStressHarness(async (h) => {
    const problems: string[] = [];
    const report: Array<Record<string, unknown>> = [];
    const restore = captureAccessLog(() => undefined);
    try {
      for (const [idx, mode] of AUTH_FAULT_MODES.entries()) {
        for (
          const [iss, provider] of [
            ["https://accounts.google.com", "google"],
            ["https://appleid.apple.com", "apple"],
          ] as const
        ) {
          const seed = iterationSeed(
            STRESS_SEED ^ 0xf1f1f1,
            idx * 2 + (provider === "apple" ? 1 : 0),
          );
          const rng = new Prng(seed);
          h.fake.reset(seed, 0);
          const userId = rng.uuid();
          h.fake.ensureUser(userId, provider);
          const permit = h.fake.addPermit(userId);
          h.fake.faults = [{ target: "gotrue_token", mode }];
          h.fake.calls = [];
          const audit = (
            await captureConsole(async () =>
              auditResponse(
                await h.handler(
                  buildRequest({
                    method: "POST",
                    pathname:
                      `/functions/v1/api/v1/analysis-permits/${permit.id}/finalize`,
                    headers: {
                      authorization: `Bearer ${providerIdToken(userId, iss)}`,
                      "content-type": "application/json",
                      "x-forwarded-for": ip(rng),
                    },
                    body: JSON.stringify({
                      outcome: pick(rng, RELEASABLE_OUTCOMES),
                    }),
                  }),
                ),
              )
            )
          ).value;
          const pgCalls = h.fake.calls.filter((c) =>
            new URL(c.url).pathname.startsWith("/rest/v1/")
          ).length;
          const row = h.fake.permits.find((p) =>
            p.id === permit.id
          )!;
          const held = {
            noLeak: audit.leaks.length === 0,
            requestId: REQUEST_ID_RE.test(audit.requestId ?? ""),
            noWrite: row.status === "reserved" && row.outcome === null &&
              pgCalls === 0,
            retryable: audit.status === 503 && audit.generic5xx === true,
          };
          report.push({
            seed,
            provider,
            mode,
            status: audit.status,
            code: audit.errorCode,
            message: audit.errorMessage,
            ...held,
          });
          for (const [name, ok] of Object.entries(held)) {
            if (!ok) {
              problems.push(
                `F1 seed=${seed} ${provider} gotrue_token:${mode} → ${name} violated (status=${audit.status} code=${audit.errorCode} msg=${
                  JSON.stringify(audit.errorMessage)
                })`,
              );
            }
          }
          h.fake.faults = [];
        }
      }
    } finally {
      restore();
    }
    const path = await writeJson("f1_provider_token_outage.json", {
      seed: STRESS_SEED,
      problems,
      report,
    });
    console.log(
      `[stress fuzz F1] ${report.length} scenarios, ${problems.length} problem(s) → ${path}`,
    );
    assertEquals(problems, []);
  }));

// ─────────────────────────────────────────────────────────────────────────────
// F2 — the lost-race branch when PostgREST answers a zero-row PATCH with 404.
//
// Found by stress_permits_finalize_pg.test.ts against a real PostgREST 9.0.1
// (every lane that lost the guarded UPDATE answered a generic 500, server log
// `RangeError: Invalid time value`). Mechanism, verified in the pinned client
// (@supabase/postgrest-js 2.112.4 PostgrestBuilder.then): a non-2xx response
// whose body is a JSON array is rewritten to `data: [], error: null` (the
// issue #295 workaround) and that branch skips the `.maybeSingle()` collapse,
// so `updated.data` is `[]` — truthy — and the route treats it as the updated
// row: `permitView([])` → `Date.parse(undefined)` → `toISOString()` throws.
// PostgREST >= 10 answers 200 `[]` (PostgREST#2343), the collapse runs, and
// the route correctly re-reads and answers 409/200 — pinned here too. The
// harness cannot tell which PostgREST hosted Supabase runs; the run against
// postgrest/postgrest:v12.2.12 and v13.0.4 held.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("stress fuzz F2: a lost guarded UPDATE must answer 409/200 regardless of PostgREST's zero-row PATCH status (200 vs 404)", () =>
  withStressHarness(async (h) => {
    const problems: string[] = [];
    const report: Array<Record<string, unknown>> = [];
    const restore = captureAccessLog(() => undefined);
    try {
      for (const [idx, zeroRowStatus] of ([200, 404] as const).entries()) {
        for (
          const [variant, expected] of [
            ["conflicting", 409],
            ["identical", 200],
          ] as const
        ) {
          const seed = iterationSeed(
            STRESS_SEED ^ 0xf2f2f2,
            idx * 2 + (variant === "identical" ? 1 : 0),
          );
          const rng = new Prng(seed);
          h.fake.reset(seed, 0);
          h.fake.zeroRowPatchStatus = zeroRowStatus;
          const userId = rng.uuid();
          const session = await h.fake.mintSession(userId);
          const permit = h.fake.addPermit(userId);
          const mine = pick(rng, RELEASABLE_OUTCOMES);
          const theirs = variant === "identical"
            ? mine
            : pick(rng, RELEASABLE_OUTCOMES.filter((o) => o !== mine));
          // A concurrent finalize commits between this request's SELECT and its
          // guarded UPDATE, so the UPDATE matches zero rows.
          h.fake.beforePatch = () => {
            permit.status = "finalized";
            permit.outcome = theirs;
          };
          h.fake.calls = [];
          const { value: audit, lines } = await captureConsole(async () =>
            auditResponse(
              await h.handler(
                buildRequest({
                  method: "POST",
                  pathname:
                    `/functions/v1/api/v1/analysis-permits/${permit.id}/finalize`,
                  headers: {
                    authorization: `Bearer ${session.accessToken}`,
                    "content-type": "application/json",
                    "x-forwarded-for": ip(rng),
                  },
                  body: JSON.stringify({ outcome: mine }),
                }),
              ),
            )
          );
          const mutated = h.fake.calls.filter((c) => c.method === "PATCH")
            .reduce(
              (s, c) => s + (c.mutated ?? 0),
              0,
            );
          const serverLog = lines.filter((l) => l.includes("[api]"));
          const held = {
            noLeak: audit.leaks.length === 0,
            requestId: REQUEST_ID_RE.test(audit.requestId ?? ""),
            noWrite: mutated === 0 && permit.status === "finalized" &&
              permit.outcome === theirs,
            verdict: audit.status === expected &&
              (expected === 200 || audit.errorCode === CONFLICT),
            no5xx: audit.status < 500,
          };
          report.push({
            seed,
            zeroRowStatus,
            variant,
            mine,
            theirs,
            status: audit.status,
            code: audit.errorCode,
            message: audit.errorMessage,
            serverLog,
            ...held,
          });
          for (const [name, ok] of Object.entries(held)) {
            if (!ok) {
              problems.push(
                `F2 seed=${seed} zeroRowPatch=${zeroRowStatus} ${variant} → ${name} violated (status=${audit.status} code=${audit.errorCode} log=${
                  JSON.stringify(serverLog)
                })`,
              );
            }
          }
        }
      }
    } finally {
      h.fake.zeroRowPatchStatus = 200;
      h.fake.beforePatch = null;
      restore();
    }
    const path = await writeJson("f2_zero_row_patch_404.json", {
      seed: STRESS_SEED,
      problems,
      report,
    });
    console.log(
      `[stress fuzz F2] ${report.length} scenarios, ${problems.length} problem(s) → ${path}`,
    );
    assertEquals(problems, []);
  }));
