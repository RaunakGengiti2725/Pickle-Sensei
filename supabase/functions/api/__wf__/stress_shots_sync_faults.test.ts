// stress: FAILURE INJECTION for POST /v1/shots:sync — every upstream the
// route touches (Supabase Auth, PostgREST replay SELECT, PostgREST RPC
// apply_synced_shot, Upstash Redis, RevenueCat) fails / times out / answers
// nonsense IN TURN, and in a few combinations, against the REAL handler.
//
// Each case (seeded from STRESS_SEED ^ fnv1a(name)) asserts:
//   fault_fired        the fault actually intercepted a call (or, for
//                      RevenueCat, that the route never called it);
//   no_false_accept    every id in acceptedIds is a row the model holds
//                      (an "accepted" for an unwritten row = data loss);
//   no_permanent_verdict
//                      an infrastructure fault never yields a verdict the
//                      mobile outbox treats as final (4xx other than
//                      401/408/429, or a non-transient rejection code) —
//                      the row must survive to retry;
//   error_class        the user-visible class is the one the contract
//                      promises for that upstream (503 for Auth outages,
//                      401 for Auth refusals, 503 for the replay lookup,
//                      per-shot shot.write_failed for the RPC, degraded-but-
//                      200 for Redis, untouched for RevenueCat);
//   no_detail_leak     5xx bodies carry no upstream detail;
//   recovered          with the fault cleared, the SAME request is accepted;
//   exactly_once       afterwards the model holds exactly one row per shot,
//                      every permit is finalized once and the free-rating
//                      ledger equals the number of scored shots — including
//                      the "RPC committed, reply lost" shape (afterWrite);
//   replay_no_rpc      a third identical send is acknowledged from the
//                      batched replay lookup without any RPC call;
//   bounded_latency    the faulted request answers inside the mobile client's
//                      20 s API_REQUEST_TIMEOUT_MS (an edge answer the app
//                      never sees is not an error class, it is a timeout).
//
// Cases carrying `finding` are KNOWN deviations (documented as findings in
// the report): they still run and record evidence, and the step fails if the
// deviation disappears (so the annotation must be removed when fixed) or if
// an invariant OTHER than the documented one breaks.
//
// A failing case is re-run 10× and its failure rate recorded. Results:
// artifacts/stress-shots-sync/latest/faults.json (STRESS_OUT_DIR overrides).
//
//   STRESS_SEED=<n>  STRESS_CASE="<case name>"  deno test -A --no-check \
//     --config deno.json stress_shots_sync_faults.test.ts

import { assert, assertEquals } from "@std/assert";
import {
  buildShots,
  envInt,
  errorClass,
  type Fault,
  fnv1a,
  grantPremium,
  leaks,
  ledgerCount,
  loadStressHarness,
  mintUser,
  ownedShotIds,
  permitStatus,
  Prng,
  send,
  type StressHarness,
  summarize,
  syncRequest,
  type Verdict,
  verdictFor,
  writeArtifact,
} from "./stress_shots_sync_harness.ts";

const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const ONLY_CASE = Deno.env.get("STRESS_CASE") ?? "";
const FLAKE_RERUNS = 10;

interface FaultCase {
  name: string;
  faults: Fault[];
  /** Shots per request (default: seeded 1..2 — a free identity's allowance). */
  shots?: number;
  /** Accept when the observed error class matches (regex). */
  expectClass: RegExp;
  /** Verdicts allowed for a VALID shot under this fault. */
  allowedVerdicts: Verdict[];
  /** Whole-request statuses that must carry Retry-After. */
  retryAfterOn?: number[];
  /** The target must not have been called at all (RevenueCat). */
  expectNoCall?: boolean;
  /** Append an invalid shot (rejected shot.invalid_payload) to the batch. */
  withInvalidShot?: boolean;
  /** The user holds a premium entitlement (needed for >2 scored shots). */
  premium?: boolean;
  /** Known deviation: the named invariants are EXPECTED to fail (a finding
   * the report carries). Anything else failing is still BROKEN. */
  finding?: { severity: "P0" | "P1" | "P2" | "P3"; invariants: string[]; note: string };
}

/** apps/mobile/src/data/api.ts API_REQUEST_TIMEOUT_MS. */
const CLIENT_TIMEOUT_MS = 20_000;

const TRANSIENT_ONLY: Verdict[] = ["request_transient"];
const RPC_FAILED: Verdict[] = ["rejected_transient"];
const OK: Verdict[] = ["accepted"];

const AUTH_OUTAGE = /^503 Session verification is temporarily unavailable/;
const AUTH_REFUSED = /^401 The session is no longer valid/;
const SELECT_OUTAGE = /^503 Shot sync is temporarily unavailable/;
const RPC_WRITE_FAILED = /^200 rejected:shot\.write_failed$/;
const ACCEPTED = /^200 accepted$/;
const RATE_LIMITED = /^429 rate_limited$/;

function authCase(
  mode: Fault["mode"],
  expectClass = AUTH_OUTAGE,
  allowed: Verdict[] = TRANSIENT_ONLY,
): FaultCase {
  return {
    name: `auth ${mode}`,
    faults: [{ target: "auth", mode }],
    expectClass,
    allowedVerdicts: allowed,
    retryAfterOn: expectClass === AUTH_OUTAGE ? [503] : [],
  };
}

function selectCase(mode: Fault["mode"], extra: Partial<FaultCase> = {}): FaultCase {
  return {
    name: `rest.select ${mode}`,
    faults: [{ target: "rest.select", mode }],
    expectClass: SELECT_OUTAGE,
    allowedVerdicts: TRANSIENT_ONLY,
    ...extra,
  };
}

function rpcCase(
  mode: Fault["mode"],
  extra: Partial<FaultCase> & { fault?: Partial<Fault> } = {},
): FaultCase {
  const { fault, ...rest } = extra;
  return {
    name: `rest.rpc ${mode}${fault?.afterWrite ? " after-write" : ""}${fault?.only !== undefined ? ` only#${fault.only}` : ""}`,
    faults: [{ target: "rest.rpc", mode, ...fault }],
    expectClass: RPC_WRITE_FAILED,
    allowedVerdicts: RPC_FAILED,
    ...rest,
  };
}

function redisCase(mode: Fault["mode"], extra: Partial<FaultCase> = {}): FaultCase {
  return {
    name: `redis ${mode}`,
    faults: [{ target: "redis", mode }],
    expectClass: ACCEPTED,
    allowedVerdicts: OK,
    ...extra,
  };
}

function rcCase(mode: Fault["mode"]): FaultCase {
  return {
    name: `revenuecat ${mode}`,
    faults: [{ target: "revenuecat", mode }],
    expectClass: ACCEPTED,
    allowedVerdicts: OK,
    expectNoCall: true,
  };
}

export const CASES: FaultCase[] = [
  // ── Supabase Auth (GET /auth/v1/user) ──
  authCase("http_500"),
  authCase("http_502"),
  authCase("http_503"),
  authCase("http_504"),
  authCase("http_429"),
  authCase("http_404"),
  authCase("timeout"),
  authCase("network_error"),
  authCase("malformed_json"),
  authCase("empty_body"),
  authCase("html_body"),
  authCase("wrong_shape_object"),
  authCase("wrong_shape_array"),
  authCase("wrong_shape_null"),
  authCase("http_401", AUTH_REFUSED, ["request_auth_retry"]),
  authCase("http_403", AUTH_REFUSED, ["request_auth_retry"]),
  authCase(
    "user_without_provider",
    /^401 The session does not belong to a Google or Apple account/,
    ["request_auth_retry"],
  ),
  {
    ...authCase("slow_ok"),
    faults: [{ target: "auth", mode: "slow_ok", delayMs: 200 }],
    expectClass: ACCEPTED,
    allowedVerdicts: OK,
    retryAfterOn: [],
  },
  {
    ...authCase("slow_ok"),
    name: "auth slow_ok past deadline",
    faults: [{ target: "auth", mode: "slow_ok", delayMs: 800 }],
  },

  // ── PostgREST: batched replay SELECT on shots ──
  selectCase("http_500"),
  selectCase("http_502"),
  selectCase("http_503"),
  // postgrest-js 2.112.4 retries a GET 503 three times sleeping Retry-After
  // each time; the route sets no deadline, so the request stalls 3×Retry-After
  selectCase("http_503", {
    name: "rest.select http_503 retry-after 7",
    faults: [{ target: "rest.select", mode: "http_503", retryAfterSeconds: 7 }],
    finding: {
      severity: "P2",
      invariants: ["bounded_latency"],
      note: "replay SELECT 503 with Retry-After: 7 holds the request ~21 s (3 client retries, no route deadline) — past the app's 20 s timeout",
    },
  }),
  selectCase("http_401"),
  selectCase("http_403"),
  selectCase("http_404"),
  selectCase("http_429"),
  selectCase("network_error"),
  selectCase("timeout"),
  selectCase("malformed_json"),
  // an empty 200 reads as "no existing rows": the RPCs run and are idempotent
  selectCase("empty_body", {
    expectClass: /^(503 Shot sync is temporarily unavailable|200 accepted)/,
    allowedVerdicts: ["request_transient", "accepted"],
  }),
  selectCase("html_body"),
  selectCase("wrong_shape_object", {
    finding: {
      severity: "P3",
      invariants: ["error_class"],
      note: "a 200 object (not array) from the replay SELECT throws TypeError in syncShots (`(existing.data ?? []).map`) → generic 500 from the outer catch instead of the route's 503; still transient + detail-free",
    },
  }),
  selectCase("wrong_shape_null", {
    expectClass: /^(503 Shot sync is temporarily unavailable|200 accepted)/,
    allowedVerdicts: ["request_transient", "accepted"],
  }),
  selectCase("slow_ok", { expectClass: ACCEPTED, allowedVerdicts: OK }),

  // ── PostgREST: apply_synced_shot RPC ──
  rpcCase("http_500"),
  rpcCase("http_502"),
  rpcCase("http_503"),
  rpcCase("http_400"),
  rpcCase("http_401"),
  rpcCase("http_403"),
  rpcCase("http_409"),
  rpcCase("http_429"),
  rpcCase("network_error"),
  rpcCase("timeout"),
  rpcCase("malformed_json"),
  rpcCase("empty_body"),
  rpcCase("html_body"),
  rpcCase("wrong_shape_object"),
  rpcCase("wrong_shape_array"),
  rpcCase("wrong_shape_null"),
  rpcCase("wrong_shape_number"),
  rpcCase("wrong_shape_string"),
  rpcCase("unknown_status"),
  rpcCase("unknown_status_control_chars"),
  rpcCase("sqlstate_status"),
  rpcCase("slow_ok", { expectClass: ACCEPTED, allowedVerdicts: OK }),
  // the RPC committed, the reply was lost
  rpcCase("network_error", { fault: { afterWrite: true } }),
  rpcCase("http_502", { fault: { afterWrite: true } }),
  rpcCase("timeout", { fault: { afterWrite: true } }),
  rpcCase("malformed_json", { fault: { afterWrite: true } }),
  // only the middle shot of the batch fails
  rpcCase("http_500", {
    shots: 3,
    premium: true,
    fault: { only: 1 },
    allowedVerdicts: ["accepted", "rejected_transient"],
  }),
  rpcCase("network_error", {
    shots: 3,
    premium: true,
    fault: { only: 1, afterWrite: true },
    allowedVerdicts: ["accepted", "rejected_transient"],
  }),
  // a premium user's larger batch under the same faults
  rpcCase("http_503", { name: "rest.rpc http_503 premium batch of 8", shots: 8, premium: true }),
  selectCase("network_error", {
    name: "rest.select network_error premium batch of 8",
    shots: 8,
    premium: true,
  }),
  // invalid entry beside the fault: it is rejected on its own, the rest retry
  rpcCase("http_503", {
    name: "rest.rpc http_503 with invalid shot",
    shots: 2,
    withInvalidShot: true,
    expectClass: /^200 rejected:shot\.invalid_payload\|shot\.write_failed$/,
  }),
  selectCase("http_503", {
    shots: 2,
    withInvalidShot: true,
    name: "rest.select http_503 with invalid shot",
  }),

  // ── Upstash Redis (L2 cache + shared rate-limit windows) ──
  redisCase("http_500"),
  redisCase("http_401"),
  redisCase("http_429"),
  redisCase("network_error"),
  redisCase("timeout"),
  redisCase("malformed_json"),
  redisCase("empty_body"),
  redisCase("html_body"),
  redisCase("wrong_shape_object"),
  redisCase("per_command_error"),
  redisCase("short_reply"),
  redisCase("nan_counter"),
  redisCase("huge_counter", {
    expectClass: RATE_LIMITED,
    allowedVerdicts: ["request_rate_limited"],
    retryAfterOn: [429],
  }),
  // Redis answers every GET with "1": the auth-cache revocation-marker slot
  // reads as "revoked" and the verdict is copied into L1 for 60 s
  redisCase("string_marker", {
    expectClass: AUTH_REFUSED,
    allowedVerdicts: ["request_auth_retry"],
    finding: {
      severity: "P3",
      invariants: ["recovered", "exactly_once", "replay_no_rpc", "ledger_stable_after_replay"],
      note: "any non-null GET reply in the revocation-marker slot is trusted as a revocation and pinned in L1 for 60 s: the user sees 401 for a minute after Redis recovers (mobile refreshes and retries; no sign-out, no data loss)",
    },
  }),

  // ── RevenueCat: never on this route ──
  rcCase("http_500"),
  rcCase("timeout"),
  rcCase("network_error"),

  // ── Combinations ──
  {
    name: "auth http_503 + redis network_error",
    faults: [
      { target: "auth", mode: "http_503" },
      { target: "redis", mode: "network_error" },
    ],
    expectClass: AUTH_OUTAGE,
    allowedVerdicts: TRANSIENT_ONLY,
    retryAfterOn: [503],
  },
  {
    name: "rest.select http_500 + redis http_500",
    faults: [
      { target: "rest.select", mode: "http_500" },
      { target: "redis", mode: "http_500" },
    ],
    expectClass: SELECT_OUTAGE,
    allowedVerdicts: TRANSIENT_ONLY,
  },
  {
    name: "rest.rpc network_error + redis malformed_json",
    faults: [
      { target: "rest.rpc", mode: "network_error" },
      { target: "redis", mode: "malformed_json" },
    ],
    expectClass: RPC_WRITE_FAILED,
    allowedVerdicts: RPC_FAILED,
  },
  {
    name: "everything down (auth+select+rpc+redis network_error)",
    faults: [
      { target: "auth", mode: "network_error" },
      { target: "rest.select", mode: "network_error" },
      { target: "rest.rpc", mode: "network_error" },
      { target: "redis", mode: "network_error" },
    ],
    expectClass: AUTH_OUTAGE,
    allowedVerdicts: TRANSIENT_ONLY,
    retryAfterOn: [503],
  },
];

interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
}

interface CaseResult {
  case: string;
  seed: number;
  premium: boolean;
  finding: FaultCase["finding"] | null;
  faults: Fault[];
  shots: number;
  shotIds: string[];
  status: number;
  errorClass: string;
  verdicts: Record<string, Verdict>;
  applied: StressHarness["injector"]["applied"];
  counters: Record<string, number>;
  restCallsHadDeadline: boolean | null;
  latencyMs: number;
  retryAfter: string | null;
  recovery: {
    status: number;
    errorClass: string;
    latencyMs: number;
    ownedRows: number;
    permits: string[];
    ledger: number;
  };
  replay: { status: number; rpcCalls: number; accepted: number };
  invariants: Invariant[];
  held: boolean;
  rerun?: { runs: number; failures: number };
  replayCommand: string;
}

const INVALID_SHOT_ID = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

async function runCase(h: StressHarness, c: FaultCase, seed: number): Promise<CaseResult> {
  const prng = new Prng(seed);
  const user = mintUser(h, prng);
  if (c.premium) grantPremium(h, user.id);
  // a free identity holds two lifetime scored ratings
  const count = c.shots ?? prng.int(1, 2);
  const shots = buildShots(h, prng, user.id, count);
  const validIds = shots.map((s) => String(s.id));
  const permitIds = shots.map((s) => String(s.analysisPermitId));
  const batch: unknown[] = [...shots];
  if (c.withInvalidShot) {
    batch.push({ ...shots[0], id: INVALID_SHOT_ID, cameraView: "overhead" });
  }
  const inv: Invariant[] = [];
  const push = (name: string, holds: boolean, detail: string) => inv.push({ name, holds, detail });

  // ── the faulted attempt
  h.resetEvidence();
  h.injector.arm(...c.faults);
  const outcome = await send(h, syncRequest(user, batch));
  const applied = [...h.injector.applied];
  const counters = { ...h.counters };
  const restCalls = h.calls.filter(
    (call) => call.target === "rest.select" || call.target === "rest.rpc",
  );
  const restCallsHadDeadline = restCalls.length ? restCalls.every((call) => call.hadSignal) : null;
  h.injector.clear();

  const verdicts: Record<string, Verdict> = {};
  for (const id of validIds) verdicts[id] = verdictFor(outcome, id);
  const owned = ownedShotIds(h, user.id);

  if (c.expectNoCall) {
    push(
      "target_not_called",
      (counters[c.faults[0].target] ?? 0) === 0,
      `${c.faults[0].target} calls=${counters[c.faults[0].target] ?? 0}`,
    );
  } else {
    push(
      "fault_fired",
      applied.length > 0,
      `applied=${applied.map((a) => `${a.target}#${a.ordinal}:${a.mode}`).join(",") || "none"}`,
    );
  }
  push(
    "no_false_accept",
    outcome.acceptedIds.every((id) => owned.has(id)),
    `accepted=${outcome.acceptedIds.length} owned=${owned.size}`,
  );
  push(
    "no_permanent_verdict",
    validIds.every((id) => c.allowedVerdicts.includes(verdicts[id])),
    `verdicts=${validIds.map((id) => verdicts[id]).join(",")} allowed=${c.allowedVerdicts.join("|")}`,
  );
  if (c.withInvalidShot) {
    const invalid =
      outcome.status === 200 ? verdictFor(outcome, INVALID_SHOT_ID) : "request_transient";
    push(
      "invalid_shot_rejected_alone",
      invalid === "rejected_contract" || outcome.status !== 200,
      `invalid verdict=${invalid} status=${outcome.status}`,
    );
  }
  const klass = errorClass(outcome);
  push("error_class", c.expectClass.test(klass), `observed="${klass}" expected=${c.expectClass}`);
  const leaked = leaks(outcome);
  push(
    "no_detail_leak",
    leaked.length === 0,
    leaked.length ? `leaked=${leaked.join(",")}` : "clean",
  );
  for (const status of c.retryAfterOn ?? []) {
    if (outcome.status === status) {
      push(
        "retry_after_present",
        outcome.headers["retry-after"] !== undefined,
        `Retry-After=${outcome.headers["retry-after"] ?? "missing"}`,
      );
    }
  }
  push(
    "request_id_present",
    typeof outcome.headers["x-request-id"] === "string",
    `x-request-id=${outcome.headers["x-request-id"] ?? "missing"}`,
  );
  push(
    "bounded_latency",
    outcome.ms < CLIENT_TIMEOUT_MS,
    `latencyMs=${outcome.ms} clientTimeoutMs=${CLIENT_TIMEOUT_MS} upstreamCalls=${h.calls.length}`,
  );

  // ── recovery: same request, fault cleared
  h.resetEvidence();
  const recovered = await send(h, syncRequest(user, batch));
  const ownedAfter = ownedShotIds(h, user.id);
  const permits = permitIds.map((id) => permitStatus(h, id));
  const ledger = ledgerCount(h, user.id);
  push(
    "recovered",
    recovered.status === 200 && validIds.every((id) => recovered.acceptedIds.includes(id)),
    `status=${recovered.status} accepted=${recovered.acceptedIds.length}/${validIds.length} class="${errorClass(recovered)}"`,
  );
  push(
    "exactly_once",
    ownedAfter.size === validIds.length &&
      validIds.every((id) => ownedAfter.has(id)) &&
      permits.every((p) => p === "finalized/scored") &&
      ledger === validIds.length,
    `rows=${ownedAfter.size}/${validIds.length} permits=${permits.join(",")} ledger=${ledger}`,
  );

  // ── replay: acknowledged without an RPC
  h.resetEvidence();
  const replayed = await send(h, syncRequest(user, batch));
  const replayRpc = h.counters["rest.rpc"] ?? 0;
  push(
    "replay_no_rpc",
    replayed.status === 200 &&
      validIds.every((id) => replayed.acceptedIds.includes(id)) &&
      replayRpc === 0,
    `status=${replayed.status} accepted=${replayed.acceptedIds.length} rpcCalls=${replayRpc}`,
  );
  push(
    "ledger_stable_after_replay",
    ledgerCount(h, user.id) === validIds.length,
    `ledger=${ledgerCount(h, user.id)}`,
  );

  return {
    case: c.name,
    seed,
    premium: Boolean(c.premium),
    finding: c.finding ?? null,
    faults: c.faults,
    shots: validIds.length,
    shotIds: validIds,
    status: outcome.status,
    errorClass: klass,
    verdicts,
    applied,
    counters,
    restCallsHadDeadline,
    latencyMs: outcome.ms,
    retryAfter: outcome.headers["retry-after"] ?? null,
    recovery: {
      status: recovered.status,
      errorClass: errorClass(recovered),
      latencyMs: recovered.ms,
      ownedRows: ownedAfter.size,
      permits,
      ledger,
    },
    replay: { status: replayed.status, rpcCalls: replayRpc, accepted: replayed.acceptedIds.length },
    invariants: inv,
    held: inv.every((i) => i.holds || c.finding?.invariants.includes(i.name)),
    replayCommand: `STRESS_SEED=${STRESS_SEED} STRESS_CASE="${c.name}" deno test -A --no-check --config deno.json stress_shots_sync_faults.test.ts`,
  };
}

Deno.test(
  "stress faults: POST /v1/shots:sync — every upstream fails in turn (seeded, replayable)",
  async (t) => {
    const h = await loadStressHarness({ redis: true, authTimeoutMs: 400 });
    const selected = ONLY_CASE ? CASES.filter((c) => c.name === ONLY_CASE) : CASES;
    assert(selected.length > 0, `no case named "${ONLY_CASE}"`);
    const names = new Set<string>();
    for (const c of CASES) {
      assert(!names.has(c.name), `duplicate case name ${c.name}`);
      names.add(c.name);
    }

    const results: CaseResult[] = [];
    const startedAt = performance.now();
    for (const c of selected) {
      const seed = (STRESS_SEED ^ fnv1a(c.name)) >>> 0;
      await t.step(c.name, async () => {
        const result = await runCase(h, c, seed);
        if (!result.held) {
          let failures = 0;
          for (let i = 0; i < FLAKE_RERUNS; i++) {
            const again = await runCase(h, c, seed);
            if (!again.held) failures += 1;
          }
          result.rerun = { runs: FLAKE_RERUNS, failures };
        }
        results.push(result);
        const expectedToFail = new Set(c.finding?.invariants ?? []);
        const broken = result.invariants.filter((i) => !i.holds && !expectedToFail.has(i.name));
        assertEquals(
          broken,
          [],
          `${c.name} (seed ${seed}) BROKEN: ${broken.map((i) => `${i.name}: ${i.detail}`).join("; ")}` +
            (result.rerun ? ` — rerun ${result.rerun.failures}/${result.rerun.runs} failed` : ""),
        );
        if (c.finding) {
          const stillFailing = result.invariants
            .filter((i) => !i.holds && expectedToFail.has(i.name))
            .map((i) => i.name);
          assertEquals(
            stillFailing.sort(),
            [...expectedToFail].sort(),
            `${c.name} (seed ${seed}): documented finding no longer reproduces — remove its \`finding\` annotation`,
          );
        }
      });
    }

    const table = {
      suite: "stress_shots_sync_faults",
      seed: STRESS_SEED,
      redis: true,
      authUpstreamTimeoutMs: 400,
      casesDefined: CASES.length,
      casesExecuted: results.length,
      scenariosExecuted: results.reduce((n, r) => n + 3 + (r.rerun ? r.rerun.runs * 3 : 0), 0),
      held: results.filter((r) => r.held && !r.finding).length,
      heldWithDocumentedFinding: results.filter((r) => r.held && r.finding).map((r) => r.case),
      broken: results.filter((r) => !r.held).map((r) => r.case),
      findings: results
        .filter((r) => r.finding)
        .map((r) => ({
          case: r.case,
          seed: r.seed,
          ...r.finding,
          observed: r.invariants.filter((i) => !i.holds).map((i) => `${i.name}: ${i.detail}`),
          replayCommand: r.replayCommand,
        })),
      latency: summarize(results.map((r) => r.latencyMs)),
      classes: Object.fromEntries(
        [...new Set(results.map((r) => r.errorClass))].map((k) => [
          k,
          results.filter((r) => r.errorClass === k).length,
        ]),
      ),
      restCallsWithoutDeadline: results.filter((r) => r.restCallsHadDeadline === false).length,
      durationMs: Math.round(performance.now() - startedAt),
      heap: Deno.memoryUsage(),
      results,
    };
    const path = await writeArtifact(ONLY_CASE ? "faults.single.json" : "faults.json", table);
    console.log(
      `[stress faults] ${results.length} cases, ${table.held} held, ${table.broken.length} broken → ${path}`,
    );
    if (!ONLY_CASE) {
      assert(results.length >= 40, `expected ≥40 fault cases, ran ${results.length}`);
    }
  },
);
