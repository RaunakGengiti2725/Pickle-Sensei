/**
 * stress · edge-drills-media · lens failure-load — FAILURE INJECTION half.
 *
 * Drives the REAL handler (../index.ts, in-process) over the drills/media
 * routes — GET /v1/catalog/drills, GET /v1/catalog/drills/:slug,
 * GET /v1/me/saved-drills, PUT|DELETE /v1/me/saved-drills/:slug — while each
 * upstream (Supabase Auth, PostgREST, Upstash, RevenueCat) is made to fail,
 * time out, or answer malformed data IN TURN, and asserts the user-visible
 * error class + recoverability (the same request succeeds once the fault is
 * lifted; table state is what a client would expect).
 *
 * Every case is a row in the `FAULT_CASES` table; each row derives its user
 * id / IP / session id from STRESS_SEED ^ fnv1a(id), so a row replays alone:
 *
 *   STRESS_ONLY=R24 deno test -A --no-check --config deno.json stress_edge_drills_media_failure.test.ts
 *
 * Verdicts: HELD rows assert the CORRECT behaviour. BROKEN rows are pinned
 * REPRO-style (the assertion documents today's wrong behaviour, `correct`
 * says what it should be) so the suite stays green while the defect stays
 * visible. A row whose outcome does not match its pin is re-run 10× and its
 * rate is written to the report before the test fails.
 *
 * Artifacts: artifacts/stress-edge-drills-media/latest/failure_cases.json
 * (or $STRESS_OUT_DIR). STRESS_REPEAT=N runs the whole table N times.
 */
import { assert, assertEquals } from "@std/assert";
import {
  answerWithin,
  edgeRequest,
  type Fault,
  type FaultMode,
  fnv1a,
  histogram,
  loadStressHarness,
  Prng,
  providerToken,
  readJson,
  sessionToken,
  STRESS_SEED,
  type StressHarness,
  type Upstream,
  writeArtifact,
} from "./stress_edge_drills_media_harness.ts";

const KNOWN_SLUG = "wall-dink-rally";
const STALL_BUDGET_MS = 1_200;
const REPEAT = Number(Deno.env.get("STRESS_REPEAT") ?? "1") || 1;
const ONLY = Deno.env.get("STRESS_ONLY") ?? "";

type Route = "list" | "detail" | "detail_unknown" | "saved" | "put" | "delete";
type Bearer = "session" | "provider";

interface Expectation {
  /** HTTP status(es) the client sees, or "stalled" (no answer in budget). */
  status: number[] | "stalled";
  code?: string;
  messageIncludes?: string;
  retryAfter?: boolean;
  /** Upper bound on end-to-end latency (ms). */
  maxMs?: number;
  /** Lower bound on end-to-end latency (ms) — pins a known stall. */
  minMs?: number;
  authCalls?: number;
  restCalls?: number;
  /** Saved rows for this user after the faulted request. */
  rows?: number;
}

interface FaultCase {
  id: string;
  upstream: Upstream;
  faults: Array<Omit<Fault, "upstream">>;
  route: Route;
  bearer: Bearer;
  /** Warm the auth cache with a clean request first (isolates non-auth upstreams). */
  warm: boolean;
  /** Pre-insert a saved row for the user. */
  seedRow?: boolean;
  /** What the pinned assertion checks (today's behaviour). */
  expect: Expectation;
  /** Status after the fault is lifted and the request is replayed. */
  recovery: number;
  /** Rows after recovery. */
  recoveryRows?: number;
  verdict: "HELD" | "BROKEN";
  /** For BROKEN rows: the behaviour that would be correct. */
  correct?: string;
  note?: string;
}

const f = (
  mode: FaultMode,
  extra: Partial<Fault> = {},
): Omit<Fault, "upstream"> => ({
  mode,
  ...extra,
});

const AUTH_503 = "Session verification is temporarily unavailable";

// ── The table ────────────────────────────────────────────────────────────────

const FAULT_CASES: FaultCase[] = [
  // Supabase Auth — contract bearer (Supabase access token → GET /auth/v1/user)
  {
    id: "S01",
    upstream: "auth",
    faults: [f("http500")],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [503], messageIncludes: AUTH_503, retryAfter: true },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "S02",
    upstream: "auth",
    faults: [f("http502_html")],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [503], messageIncludes: AUTH_503, retryAfter: true },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "S03",
    upstream: "auth",
    faults: [f("http503_retry_after")],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [503], messageIncludes: AUTH_503, retryAfter: true },
    recovery: 200,
    verdict: "HELD",
    note: "upstream Retry-After: 7 is forwarded",
  },
  {
    id: "S04",
    upstream: "auth",
    faults: [f("http429")],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [503], retryAfter: true },
    recovery: 200,
    verdict: "HELD",
    note: "Auth 429 is capacity, not a credential verdict",
  },
  {
    id: "S05",
    upstream: "auth",
    faults: [f("http401")],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [401] },
    recovery: 200,
    verdict: "HELD",
    note: "credential refusal → 401; no negative cache (recovery 200)",
  },
  {
    id: "S06",
    upstream: "auth",
    faults: [f("http403_grant")],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [401] },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "S07",
    upstream: "auth",
    faults: [f("http404")],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [503], retryAfter: true },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "S08",
    upstream: "auth",
    faults: [f("network_reject")],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [503], retryAfter: true, maxMs: 1_500 },
    recovery: 200,
    verdict: "HELD",
    note: "connection failures retried within the 400ms deadline, then 503",
  },
  {
    id: "S09",
    upstream: "auth",
    faults: [f("network_reject", { nth: 1 })],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [200], authCalls: 2 },
    recovery: 200,
    verdict: "HELD",
    note: "one reset connection is retried transparently",
  },
  {
    id: "S10",
    upstream: "auth",
    faults: [f("hang")],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [503], retryAfter: true, maxMs: 1_000 },
    recovery: 200,
    verdict: "HELD",
    note: "AUTH_UPSTREAM_TIMEOUT_MS deadline (400ms here) bounds a hung Auth",
  },
  {
    id: "S11",
    upstream: "auth",
    faults: [f("malformed_json")],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [503], retryAfter: true },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "S12",
    upstream: "auth",
    faults: [f("empty_200")],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [503], retryAfter: true },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "S13",
    upstream: "auth",
    faults: [f("shape_object")],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [503], retryAfter: true },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "S14",
    upstream: "auth",
    faults: [f("shape_null")],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [503], retryAfter: true },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "S15",
    upstream: "auth",
    faults: [f("shape_string")],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [503], retryAfter: true },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "S16",
    upstream: "auth",
    faults: [f("truncated_json")],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [503], retryAfter: true },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "S17",
    upstream: "auth",
    faults: [f("shape_no_provider")],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [401] },
    recovery: 200,
    verdict: "HELD",
    note:
      "a verified user without a Google/Apple identity is refused, not retried",
  },
  {
    id: "S18",
    upstream: "auth",
    faults: [f("slow", { delayMs: 250 })],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [200], authCalls: 1 },
    recovery: 200,
    verdict: "HELD",
    note: "slow-but-alive Auth under the deadline still answers",
  },

  // Supabase Auth — TRANSITIONAL provider bearer (Google ID token → signInWithIdToken)
  {
    id: "P01",
    upstream: "auth",
    faults: [f("http500")],
    route: "list",
    bearer: "provider",
    warm: false,
    expect: {
      status: [401],
      messageIncludes: "identity token could not be verified",
    },
    recovery: 200,
    verdict: "BROKEN",
    correct: "503 + Retry-After (Auth outage), like the contract bearer path",
  },
  {
    id: "P02",
    upstream: "auth",
    faults: [f("network_reject")],
    route: "list",
    bearer: "provider",
    warm: false,
    expect: { status: [401] },
    recovery: 200,
    verdict: "BROKEN",
    correct:
      "503 + Retry-After; a reset connection is not a credential verdict",
  },
  {
    id: "P03",
    upstream: "auth",
    faults: [f("hang")],
    route: "list",
    bearer: "provider",
    warm: false,
    expect: { status: "stalled" },
    recovery: 200,
    verdict: "BROKEN",
    correct:
      "503 within AUTH_UPSTREAM_TIMEOUT_MS; supabase-js signInWithIdToken has no deadline",
  },
  {
    id: "P04",
    upstream: "auth",
    faults: [f("malformed_json")],
    route: "list",
    bearer: "provider",
    warm: false,
    expect: { status: [401] },
    recovery: 200,
    verdict: "BROKEN",
    correct: "503; a malformed 200 is an upstream fault",
  },
  {
    id: "P05",
    upstream: "auth",
    faults: [f("http429")],
    route: "list",
    bearer: "provider",
    warm: false,
    expect: { status: [401] },
    recovery: 200,
    verdict: "BROKEN",
    correct: "503 + Retry-After (capacity)",
  },
  {
    id: "P06",
    upstream: "auth",
    faults: [f("http401")],
    route: "list",
    bearer: "provider",
    warm: false,
    expect: { status: [401] },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "P07",
    upstream: "auth",
    faults: [f("slow", { delayMs: 250 })],
    route: "list",
    bearer: "provider",
    warm: false,
    expect: { status: [200], authCalls: 1 },
    recovery: 200,
    verdict: "HELD",
  },

  // PostgREST — auth cache warm, so only the DB round trips are in play
  {
    id: "R01",
    upstream: "rest",
    faults: [f("http500")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: {
      status: [503],
      messageIncludes: "Drill catalog is temporarily unavailable",
    },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "R02",
    upstream: "rest",
    faults: [f("http502_html")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [503] },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "R03",
    upstream: "rest",
    faults: [f("http401_pgrst301")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [503] },
    recovery: 200,
    verdict: "HELD",
    note:
      "PostgREST JWT refusal surfaces as retryable 503 (auth cache TTL ≤ token expiry makes it unreachable in practice)",
  },
  {
    id: "R04",
    upstream: "rest",
    faults: [f("network_reject")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [503], restCalls: 4, minMs: 6_500 },
    recovery: 200,
    verdict: "BROKEN",
    correct:
      "503 within ~1s — postgrest-js 2.112.4 retries GET network errors 3× (1s/2s/4s backoff) with no deadline, so a reset PostgREST connection costs the user 7s",
  },
  {
    id: "R04b",
    upstream: "rest",
    faults: [f("http503_retry_after_1s")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [503], restCalls: 4, minMs: 2_900 },
    recovery: 200,
    verdict: "BROKEN",
    correct:
      "503 promptly — postgrest-js also retries GET on upstream 503/520 and sleeps the upstream Retry-After UNCAPPED before each of its 3 retries (Retry-After: 1 → 3s here; 7 → 21s)",
  },
  {
    id: "R04c",
    upstream: "rest",
    faults: [f("network_reject", { nth: 1 })],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [200], restCalls: 2, minMs: 900 },
    recovery: 200,
    verdict: "HELD",
    note:
      "one reset PostgREST connection is retried transparently (after a 1s pause)",
  },
  {
    id: "R05",
    upstream: "rest",
    faults: [f("hang")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: "stalled" },
    recovery: 200,
    verdict: "BROKEN",
    correct: "bounded 503 — no deadline/AbortSignal on PostgREST reads",
  },
  {
    id: "R06",
    upstream: "rest",
    faults: [f("malformed_json")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [503] },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "R07",
    upstream: "rest",
    faults: [f("truncated_json")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [503] },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "R08",
    upstream: "rest",
    faults: [f("shape_object")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [500] },
    recovery: 200,
    verdict: "BROKEN",
    correct:
      "503 Drill catalog unavailable — `(saved.data ?? []).map` throws on a non-array 200 body",
  },
  {
    id: "R09",
    upstream: "rest",
    faults: [f("shape_null")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [200] },
    recovery: 200,
    verdict: "HELD",
    note: "null data coalesces to 'nothing saved'",
  },
  {
    id: "R10",
    upstream: "rest",
    faults: [f("shape_string")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [500] },
    recovery: 200,
    verdict: "BROKEN",
    correct: "503 (same non-array crash as R08)",
  },
  {
    id: "R11",
    upstream: "rest",
    faults: [f("empty_200")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [200, 503] },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "R12",
    upstream: "rest",
    faults: [f("http500")],
    route: "detail",
    bearer: "session",
    warm: true,
    expect: {
      status: [503],
      messageIncludes: "Drill detail is temporarily unavailable",
    },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "R13",
    upstream: "rest",
    faults: [f("malformed_json")],
    route: "detail",
    bearer: "session",
    warm: true,
    expect: { status: [503] },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "R14",
    upstream: "rest",
    faults: [f("hang")],
    route: "detail",
    bearer: "session",
    warm: true,
    expect: { status: "stalled" },
    recovery: 200,
    verdict: "BROKEN",
    correct: "bounded 503",
  },
  {
    id: "R15",
    upstream: "rest",
    faults: [f("shape_two_rows")],
    route: "detail",
    bearer: "session",
    warm: true,
    expect: { status: [200, 503] },
    recovery: 200,
    verdict: "HELD",
    note: "maybeSingle over a 2-row answer never leaks a crash",
  },
  {
    id: "R16",
    upstream: "rest",
    faults: [f("http406")],
    route: "detail",
    bearer: "session",
    warm: true,
    expect: { status: [200, 503] },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "R17",
    upstream: "rest",
    faults: [f("network_reject")],
    route: "detail",
    bearer: "session",
    warm: true,
    expect: { status: [503], restCalls: 4, minMs: 6_500 },
    recovery: 200,
    verdict: "BROKEN",
    correct: "bounded 503 (same 7s postgrest-js retry loop as R04)",
  },
  {
    id: "R18",
    upstream: "rest",
    faults: [f("http500")],
    route: "detail_unknown",
    bearer: "session",
    warm: true,
    expect: { status: [404], code: "drill.not_found" },
    recovery: 404,
    verdict: "HELD",
    note: "unknown slug is answered before any DB round trip",
  },
  {
    id: "R19",
    upstream: "rest",
    faults: [f("http500")],
    route: "saved",
    bearer: "session",
    warm: true,
    expect: {
      status: [503],
      messageIncludes: "Saved drills is temporarily unavailable",
    },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "R20",
    upstream: "rest",
    faults: [f("shape_null_slug")],
    route: "saved",
    bearer: "session",
    warm: true,
    expect: { status: [200] },
    recovery: 200,
    verdict: "HELD",
    note: "a null slug row hydrates to a placeholder, never a crash",
  },
  {
    id: "R21",
    upstream: "rest",
    faults: [f("shape_object")],
    route: "saved",
    bearer: "session",
    warm: true,
    expect: { status: [500] },
    recovery: 200,
    verdict: "BROKEN",
    correct: "503 (non-array 200 body crashes the list hydration)",
  },
  {
    id: "R22",
    upstream: "rest",
    faults: [f("hang")],
    route: "saved",
    bearer: "session",
    warm: true,
    expect: { status: "stalled" },
    recovery: 200,
    verdict: "BROKEN",
    correct: "bounded 503",
  },
  {
    id: "R23",
    upstream: "rest",
    faults: [f("http500", { method: "POST" })],
    route: "put",
    bearer: "session",
    warm: true,
    expect: {
      status: [503],
      messageIncludes: "Drill save is temporarily unavailable",
      rows: 0,
    },
    recovery: 200,
    recoveryRows: 1,
    verdict: "HELD",
  },
  {
    id: "R24",
    upstream: "rest",
    faults: [f("network_reject", { method: "POST" })],
    route: "put",
    bearer: "session",
    warm: true,
    expect: { status: [503], rows: 0, restCalls: 1, maxMs: 500 },
    recovery: 200,
    recoveryRows: 1,
    verdict: "HELD",
    note:
      "the upsert (POST) is never retried by the client — no double-write on a reset connection",
  },
  {
    id: "R25",
    upstream: "rest",
    faults: [f("http500", { method: "GET" })],
    route: "put",
    bearer: "session",
    warm: true,
    expect: { status: [503], rows: 1 },
    recovery: 200,
    recoveryRows: 1,
    verdict: "HELD",
    note:
      "upsert landed, read-back failed → 503; the retry is idempotent (still 1 row)",
  },
  {
    id: "R26",
    upstream: "rest",
    faults: [f("shape_null", { method: "GET" })],
    route: "put",
    bearer: "session",
    warm: true,
    expect: { status: [503], rows: 1 },
    recovery: 200,
    recoveryRows: 1,
    verdict: "HELD",
  },
  {
    id: "R27",
    upstream: "rest",
    faults: [f("http406", { method: "GET" })],
    route: "put",
    bearer: "session",
    warm: true,
    expect: { status: [503], rows: 1 },
    recovery: 200,
    recoveryRows: 1,
    verdict: "HELD",
  },
  {
    id: "R28",
    upstream: "rest",
    faults: [f("http409_unique", { method: "POST" })],
    route: "put",
    bearer: "session",
    warm: true,
    expect: { status: [503], rows: 0 },
    recovery: 200,
    recoveryRows: 1,
    verdict: "HELD",
  },
  {
    id: "R29",
    upstream: "rest",
    faults: [f("http400_check_violation", { method: "POST" })],
    route: "put",
    bearer: "session",
    warm: true,
    expect: { status: [503], rows: 0 },
    recovery: 200,
    recoveryRows: 1,
    verdict: "HELD",
    note:
      "DB slug bounds disagreeing with DRILL_SLUG_RE would surface as 503 (regexes are aligned today)",
  },
  {
    id: "R30",
    upstream: "rest",
    faults: [f("http403_grant", { method: "POST" })],
    route: "put",
    bearer: "session",
    warm: true,
    expect: { status: [503], rows: 0 },
    recovery: 200,
    recoveryRows: 1,
    verdict: "HELD",
  },
  {
    id: "R31",
    upstream: "rest",
    faults: [f("http401_pgrst301", { method: "POST" })],
    route: "put",
    bearer: "session",
    warm: true,
    expect: { status: [503], rows: 0 },
    recovery: 200,
    recoveryRows: 1,
    verdict: "HELD",
  },
  {
    id: "R32",
    upstream: "rest",
    faults: [f("hang", { method: "POST" })],
    route: "put",
    bearer: "session",
    warm: true,
    expect: { status: "stalled" },
    recovery: 200,
    recoveryRows: 1,
    verdict: "BROKEN",
    correct: "bounded 503",
  },
  {
    id: "R33",
    upstream: "rest",
    faults: [f("malformed_json", { method: "POST" })],
    route: "put",
    bearer: "session",
    warm: true,
    expect: { status: [200, 503] },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "R34",
    upstream: "rest",
    faults: [f("http500")],
    route: "delete",
    bearer: "session",
    warm: true,
    seedRow: true,
    expect: {
      status: [503],
      messageIncludes: "Drill unsave is temporarily unavailable",
      rows: 1,
    },
    recovery: 204,
    recoveryRows: 0,
    verdict: "HELD",
  },
  {
    id: "R35",
    upstream: "rest",
    faults: [f("network_reject")],
    route: "delete",
    bearer: "session",
    warm: true,
    seedRow: true,
    expect: { status: [503], rows: 1 },
    recovery: 204,
    recoveryRows: 0,
    verdict: "HELD",
  },
  {
    id: "R36",
    upstream: "rest",
    faults: [f("hang")],
    route: "delete",
    bearer: "session",
    warm: true,
    seedRow: true,
    expect: { status: "stalled" },
    recovery: 204,
    recoveryRows: 0,
    verdict: "BROKEN",
    correct: "bounded 503",
  },
  {
    id: "R37",
    upstream: "rest",
    faults: [f("malformed_json")],
    route: "delete",
    bearer: "session",
    warm: true,
    seedRow: true,
    expect: { status: [204, 503] },
    recovery: 204,
    recoveryRows: 0,
    verdict: "HELD",
  },
  {
    id: "R38",
    upstream: "rest",
    faults: [f("http401_pgrst301")],
    route: "delete",
    bearer: "session",
    warm: true,
    seedRow: true,
    expect: { status: [503], rows: 1 },
    recovery: 204,
    recoveryRows: 0,
    verdict: "HELD",
  },

  // Upstash Redis — configured for this file; must fail OPEN to per-isolate memory
  {
    id: "U01",
    upstream: "upstash",
    faults: [f("http500")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [200] },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "U02",
    upstream: "upstash",
    faults: [f("http401")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [200] },
    recovery: 200,
    verdict: "HELD",
    note: "bad Upstash token never blocks users",
  },
  {
    id: "U03",
    upstream: "upstash",
    faults: [f("network_reject")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [200] },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "U04",
    upstream: "upstash",
    faults: [f("hang")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [200], maxMs: 8_000 },
    recovery: 200,
    verdict: "HELD",
    note:
      "each pipeline call aborts at REDIS_TIMEOUT_MS=1200 — latency is recorded",
  },
  {
    id: "U05",
    upstream: "upstash",
    faults: [f("malformed_json")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [200] },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "U06",
    upstream: "upstash",
    faults: [f("shape_object")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [200] },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "U07",
    upstream: "upstash",
    faults: [f("empty_200")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [200] },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "U08",
    upstream: "upstash",
    faults: [f("redis_slot_error")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [200] },
    recovery: 200,
    verdict: "HELD",
    note: "OOM per-command errors → memory fallback",
  },
  {
    id: "U09",
    upstream: "upstash",
    faults: [f("redis_incr_huge")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [429], code: "rate_limited", retryAfter: true },
    recovery: 200,
    verdict: "HELD",
    note: "L2 counters are authoritative when Redis answers",
  },
  {
    id: "U10",
    upstream: "upstash",
    faults: [f("redis_incr_string")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [200] },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "U11",
    upstream: "upstash",
    faults: [f("redis_get_garbage")],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [200], authCalls: 1 },
    recovery: 200,
    verdict: "HELD",
    note: "garbage in the auth cache → re-verify with Auth, not a crash",
  },
  {
    id: "U12",
    upstream: "upstash",
    faults: [f("redis_get_wrong_json")],
    route: "list",
    bearer: "session",
    warm: false,
    expect: { status: [200], authCalls: 1 },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "U13",
    upstream: "upstash",
    faults: [f("http500", { nth: 1 })],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [200] },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "U14",
    upstream: "upstash",
    faults: [f("http429")],
    route: "put",
    bearer: "session",
    warm: true,
    expect: { status: [200], rows: 1 },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "U15",
    upstream: "upstash",
    faults: [f("http503_retry_after")],
    route: "delete",
    bearer: "session",
    warm: true,
    seedRow: true,
    expect: { status: [204], rows: 0 },
    recovery: 204,
    verdict: "HELD",
  },

  // RevenueCat — the drills routes must never depend on it (blast radius = 0)
  {
    id: "C01",
    upstream: "revenuecat",
    faults: [f("http500")],
    route: "list",
    bearer: "session",
    warm: true,
    expect: { status: [200] },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "C02",
    upstream: "revenuecat",
    faults: [f("hang")],
    route: "put",
    bearer: "session",
    warm: true,
    expect: { status: [200], rows: 1, maxMs: STALL_BUDGET_MS },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "C03",
    upstream: "revenuecat",
    faults: [f("malformed_json")],
    route: "saved",
    bearer: "session",
    warm: true,
    expect: { status: [200] },
    recovery: 200,
    verdict: "HELD",
  },
  {
    id: "C04",
    upstream: "revenuecat",
    faults: [f("network_reject")],
    route: "delete",
    bearer: "session",
    warm: true,
    seedRow: true,
    expect: { status: [204], rows: 0 },
    recovery: 204,
    verdict: "HELD",
  },
];

// ── Execution ────────────────────────────────────────────────────────────────

interface CaseRow {
  id: string;
  seed: number;
  userId: string;
  ip: string;
  upstream: Upstream;
  faults: Array<Omit<Fault, "upstream">>;
  route: Route;
  bearer: Bearer;
  verdict: "HELD" | "BROKEN";
  correct?: string;
  note?: string;
  observed: {
    status: number | "stalled";
    body: unknown;
    retryAfter: string | null;
    ms: number;
    calls: string[];
    authCalls: number;
    restCalls: number;
    upstashCalls: number;
    revenuecatCalls: number;
    rows: number;
    operatorLog: string[];
  };
  recovery: { status: number | "stalled"; rows: number; authCalls: number };
  match: boolean;
  mismatch: string[];
  flakeRate?: string;
  replay: string;
}

function requestFor(route: Route, token: string, ip: string): Request {
  switch (route) {
    case "list":
      return edgeRequest("GET", "/v1/catalog/drills", { token, ip });
    case "detail":
      return edgeRequest("GET", `/v1/catalog/drills/${KNOWN_SLUG}`, {
        token,
        ip,
      });
    case "detail_unknown":
      return edgeRequest("GET", "/v1/catalog/drills/not-a-catalog-slug", {
        token,
        ip,
      });
    case "saved":
      return edgeRequest("GET", "/v1/me/saved-drills", { token, ip });
    case "put":
      return edgeRequest("PUT", `/v1/me/saved-drills/${KNOWN_SLUG}`, {
        token,
        ip,
      });
    case "delete":
      return edgeRequest("DELETE", `/v1/me/saved-drills/${KNOWN_SLUG}`, {
        token,
        ip,
      });
  }
}

const LEAK_MARKERS = [
  "XX000",
  "PGRST",
  "23514",
  "42501",
  "23505",
  "stress",
  "internal error",
  "stack",
];

async function runCase(
  h: StressHarness,
  c: FaultCase,
  attempt = 0,
): Promise<CaseRow> {
  const seed = (STRESS_SEED ^ fnv1a(`${c.id}:${attempt}`)) >>> 0;
  const prng = new Prng(seed);
  const userId = prng.uuid();
  const ip = prng.ip();
  const token = c.bearer === "session"
    ? sessionToken(userId, `sess-${prng.uuid()}`)
    : providerToken(userId);
  h.faults = [];
  // Distinct user + IP per row: no rate-limit or auth-cache state crosses rows.
  if (c.warm) {
    const warm = await h.handler(
      edgeRequest("GET", "/v1/catalog/drills", { token, ip }),
    );
    await warm.body?.cancel();
    assertEquals(warm.status, 200, `${c.id}: warm-up must succeed`);
  }
  h.savedDrills = h.savedDrills.filter((row) => row.user_id !== userId);
  if (c.seedRow) {
    h.savedDrills.push({
      user_id: userId,
      slug: KNOWN_SLUG,
      saved_at: new Date().toISOString(),
    });
  }
  h.faults = c.faults.map((fault) => ({ upstream: c.upstream, ...fault }));
  const mark = h.calls.length;
  const logMark = h.operatorLog.length;
  const budget = c.expect.status === "stalled"
    ? STALL_BUDGET_MS
    : Math.max(c.expect.maxMs ?? 0, 10_000);
  const { response, stalled, ms, pending } = await answerWithin(
    h.handler,
    requestFor(c.route, token, ip),
    budget,
  );
  const body = response ? await readJson(response) : null;
  const calls = h.callsSince(mark);
  const count = (u: Upstream) =>
    calls.filter((call) => call.upstream === u).length;
  const rowsOf = () =>
    h.savedDrills.filter((row) => row.user_id === userId).length;
  const observed: CaseRow["observed"] = {
    status: stalled ? "stalled" : response!.status,
    body,
    retryAfter: response?.headers.get("Retry-After") ?? null,
    ms,
    calls: calls.map((call) =>
      `${call.upstream}:${call.method}:${call.outcome}`
    ),
    authCalls: count("auth"),
    restCalls: count("rest"),
    upstashCalls: count("upstash"),
    revenuecatCalls: count("revenuecat"),
    rows: rowsOf(),
    operatorLog: h.operatorLog.slice(logMark),
  };
  await pending; // let a hung handler finish (hang cap) before lifting faults
  h.faults = [];

  const recoveryMark = h.calls.length;
  const recovered = await h.handler(requestFor(c.route, token, ip));
  await recovered.body?.cancel();
  const recovery = {
    status: recovered.status as number | "stalled",
    rows: rowsOf(),
    authCalls:
      h.callsSince(recoveryMark).filter((call) => call.upstream === "auth")
        .length,
  };

  const mismatch: string[] = [];
  const e = c.expect;
  if (e.status === "stalled") {
    if (!stalled) {
      mismatch.push(`expected stall, got ${observed.status} in ${ms}ms`);
    }
  } else {
    if (stalled) {
      mismatch.push(`stalled (> ${budget}ms), expected ${e.status.join("|")}`);
    } else if (!e.status.includes(observed.status as number)) {
      mismatch.push(`status ${observed.status} ∉ ${e.status.join("|")}`);
    }
  }
  const error = (body?.error ?? {}) as { code?: string; message?: string };
  if (e.code && error.code !== e.code) {
    mismatch.push(`code ${error.code} ≠ ${e.code}`);
  }
  if (e.messageIncludes && !(error.message ?? "").includes(e.messageIncludes)) {
    mismatch.push(`message "${error.message}" lacks "${e.messageIncludes}"`);
  }
  if (e.retryAfter && !observed.retryAfter) {
    mismatch.push("missing Retry-After");
  }
  if (e.maxMs !== undefined && ms > e.maxMs) {
    mismatch.push(`took ${ms}ms > ${e.maxMs}ms`);
  }
  if (e.minMs !== undefined && ms < e.minMs) {
    mismatch.push(`took ${ms}ms < ${e.minMs}ms`);
  }
  if (e.authCalls !== undefined && observed.authCalls !== e.authCalls) {
    mismatch.push(`authCalls ${observed.authCalls} ≠ ${e.authCalls}`);
  }
  if (e.restCalls !== undefined && observed.restCalls !== e.restCalls) {
    mismatch.push(`restCalls ${observed.restCalls} ≠ ${e.restCalls}`);
  }
  if (e.rows !== undefined && observed.rows !== e.rows) {
    mismatch.push(`rows ${observed.rows} ≠ ${e.rows}`);
  }
  if (observed.revenuecatCalls !== 0) {
    mismatch.push(
      `drills route called RevenueCat ${observed.revenuecatCalls}×`,
    );
  }
  if (recovery.status !== c.recovery) {
    mismatch.push(`recovery ${recovery.status} ≠ ${c.recovery}`);
  }
  if (c.recoveryRows !== undefined && recovery.rows !== c.recoveryRows) {
    mismatch.push(`recovery rows ${recovery.rows} ≠ ${c.recoveryRows}`);
  }
  if (response && response.status >= 500) {
    const text = JSON.stringify(body);
    for (const marker of LEAK_MARKERS) {
      if (text.includes(marker)) {
        mismatch.push(`5xx body leaks upstream detail "${marker}"`);
      }
    }
  }
  // Every 503 must leave an operator trace (detail lives in logs, not the body).
  if (
    response?.status === 503 &&
    !observed.operatorLog.some((line) => line.includes("[api]"))
  ) {
    mismatch.push("503 without an operator log line");
  }

  return {
    id: c.id,
    seed,
    userId,
    ip,
    upstream: c.upstream,
    faults: c.faults,
    route: c.route,
    bearer: c.bearer,
    verdict: c.verdict,
    correct: c.correct,
    note: c.note,
    observed,
    recovery,
    match: mismatch.length === 0,
    mismatch,
    replay:
      `STRESS_SEED=${STRESS_SEED} STRESS_ONLY=${c.id} deno test -A --no-check --config deno.json stress_edge_drills_media_failure.test.ts`,
  };
}

Deno.test("stress · edge-drills-media · failure injection: every upstream fails/times out/answers malformed in turn", async () => {
  const h = await loadStressHarness({ redis: true });
  const selected = ONLY
    ? FAULT_CASES.filter((c) => c.id === ONLY)
    : FAULT_CASES;
  assert(selected.length > 0, `no case matches STRESS_ONLY=${ONLY}`);
  assert(FAULT_CASES.length >= 40, "the lens requires ≥40 fault cases");
  const ids = new Set(FAULT_CASES.map((c) => c.id));
  assertEquals(ids.size, FAULT_CASES.length, "case ids must be unique");

  const rows: CaseRow[] = [];
  const started = performance.now();
  for (let repeat = 0; repeat < REPEAT; repeat++) {
    for (const c of selected) {
      const row = await runCase(h, c, repeat);
      if (!row.match) {
        // Flaky or wrong pin? Re-run the seed 10× and record the rate.
        let failures = 0;
        for (let i = 1; i <= 10; i++) {
          const again = await runCase(h, c, repeat * 1_000 + i);
          if (!again.match) failures += 1;
        }
        row.flakeRate = `${failures}/10 re-runs mismatched`;
      }
      rows.push(row);
    }
  }

  const byVerdict = histogram(rows.map((row) => row.verdict));
  const byUpstream = histogram(rows.map((row) => row.upstream));
  const path = await writeArtifact("failure_cases.json", {
    scenario: "stress-edge-drills-media/failure-injection",
    seed: STRESS_SEED,
    repeat: REPEAT,
    cases: rows.length,
    byVerdict,
    byUpstream,
    mismatched: rows.filter((row) => !row.match).map((row) => row.id),
    durationMs: Math.round(performance.now() - started),
    heap: Deno.memoryUsage(),
    rows,
  });
  const mismatched = rows.filter((row) => !row.match);
  assertEquals(
    mismatched.map((row) =>
      `${row.id}: ${row.mismatch.join("; ")} [${row.flakeRate}]`
    ),
    [],
    `fault cases disagree with their pins — see ${path}`,
  );
  h.dispose();
});
