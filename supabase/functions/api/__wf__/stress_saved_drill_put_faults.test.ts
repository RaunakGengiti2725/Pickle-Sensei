// stress — `PUT /v1/me/saved-drills/:slug` failure injection.
//
// Every upstream the route can reach (Supabase Auth, PostgREST upsert,
// PostgREST read-back, Upstash Redis) is made to refuse, error, time out or
// answer garbage IN TURN while the REAL handler runs in-process, and each
// scenario asserts:
//   • the user-visible error class (200 / 401 / 429 / 503 — never a 500),
//   • that no upstream detail leaks into the body (PostgREST codes, table
//     names, stack frames, "redis"…),
//   • recoverability: once the upstream is healthy again the same bearer
//     saves the drill and the row exists,
//   • how many upstream round trips the failure cost.
// RevenueCat is armed too, and the run proves the route never reaches it.
//
// The isolate is configured WITH Upstash (production shape) and a shortened
// Auth deadline (STRESS_AUTH_TIMEOUT_MS, default 1500 ms; production 6000)
// so the suite stays fast — the campaign run uses 6000.
//
// Known divergences between expected and observed behaviour are pinned in
// KNOWN_DIVERGENCES so a fix (or a new regression) flips this test loudly;
// the per-case verdicts land in the JSON artifact
// (STRESS_OUT_DIR, default artifacts/stress-saved-drill-put/latest/).
//
// Replay one case:  STRESS_SEED=<seed> STRESS_CASE=<id> deno test -A \
//   --no-check --config deno.json stress_saved_drill_put_faults.test.ts

import {
  type Answer,
  drive,
  envInt,
  fakeGoogleIdToken,
  FakeUpstreams,
  type FaultMode,
  leaks,
  loadStressHarness,
  Prng,
  putSavedDrill,
  sleep,
  STRESS_SEED,
  type Upstream,
  writeArtifact,
} from "./stress_saved_drill_put_harness.ts";

const AUTH_TIMEOUT_MS = envInt("STRESS_AUTH_TIMEOUT_MS", 1_500);
const h = await loadStressHarness({
  redis: true,
  authTimeoutMs: AUTH_TIMEOUT_MS,
});

type Bearer = "session" | "session_warm" | "provider";
type ErrorClass =
  | "ok"
  | "auth_rejected"
  | "unavailable"
  | "rate_limited"
  | "hang";

interface FaultCase {
  id: string;
  target: Upstream;
  mode: FaultMode;
  bearer: Bearer;
  /** Distinguishes two cases with the same target/mode/bearer. */
  variant?: string;
  /** Matching upstream calls the fault consumes (default 1). */
  count?: number;
  retryAfter?: string;
  slowMs?: number;
  /** What a correct edge should show the user. */
  expect: { status: number; klass: ErrorClass };
  /** Handler deadline for this case (default 2 s; healthy calls take < 10 ms). */
  deadlineMs?: number;
  /** ≥ 7 s cases (client retry ladders, Redis timeouts) — run with STRESS_SLOW=1. */
  slow?: boolean;
  note?: string;
}

const HTTP_REFUSALS = ["http_400", "http_401", "http_403"] as const;
const HTTP_OUTAGES = [
  "http_404",
  "http_409",
  "http_429",
  "http_500",
  "http_502",
  "http_503",
  "http_504",
] as const;
const TRANSPORT_FAULTS = [
  "network_error",
  "malformed_json",
  "html_body",
  "empty_body",
  "wrong_shape",
  "truncated_stream",
] as const;

function buildCases(): FaultCase[] {
  const cases: FaultCase[] = [];
  const add = (c: Omit<FaultCase, "id">) => {
    const id = `${c.target}/${c.mode}/${c.bearer}${
      c.variant ? `/${c.variant}` : ""
    }`;
    if (cases.some((existing) => existing.id === id)) {
      throw new Error(`duplicate fault case ${id}`);
    }
    cases.push({ id, ...c });
  };
  const unavailable = { status: 503, klass: "unavailable" as const };
  const rejected = { status: 401, klass: "auth_rejected" as const };
  const ok = { status: 200, klass: "ok" as const };

  // ── Supabase Auth, session bearer (production path, cold cache) ──
  for (const mode of HTTP_REFUSALS) {
    add({ target: "gotrue_user", mode, bearer: "session", expect: rejected });
  }
  for (const mode of HTTP_OUTAGES) {
    add({
      target: "gotrue_user",
      mode,
      bearer: "session",
      expect: unavailable,
    });
  }
  for (const mode of TRANSPORT_FAULTS) {
    add({
      target: "gotrue_user",
      mode,
      bearer: "session",
      count: Infinity,
      expect: unavailable,
      note: mode === "network_error"
        ? "authRequest retries connect failures inside the deadline"
        : undefined,
    });
  }
  add({
    target: "gotrue_user",
    mode: "timeout",
    bearer: "session",
    count: Infinity,
    expect: unavailable,
    deadlineMs: AUTH_TIMEOUT_MS + 2_000,
    note: "GoTrue socket hangs; edge must give up at AUTH_UPSTREAM_TIMEOUT_MS",
  });
  add({
    target: "gotrue_user",
    mode: "slow_ok",
    bearer: "session",
    slowMs: 300,
    expect: ok,
  });
  add({
    target: "gotrue_user",
    mode: "http_503",
    bearer: "session_warm",
    count: Infinity,
    expect: ok,
    note:
      "Auth outage must be invisible to a bearer verified inside the cache window",
  });

  // ── Supabase Auth, transitional provider ID token ──
  for (const mode of HTTP_REFUSALS) {
    add({ target: "gotrue_token", mode, bearer: "provider", expect: rejected });
  }
  for (
    const mode of ["http_500", "http_502", "http_503", "http_504"] as const
  ) {
    add({
      target: "gotrue_token",
      mode,
      bearer: "provider",
      expect: unavailable,
    });
  }
  for (const mode of TRANSPORT_FAULTS) {
    add({
      target: "gotrue_token",
      mode,
      bearer: "provider",
      count: Infinity,
      expect: unavailable,
    });
  }
  add({
    target: "gotrue_token",
    mode: "timeout",
    bearer: "provider",
    count: Infinity,
    expect: unavailable,
    deadlineMs: AUTH_TIMEOUT_MS + 2_000,
  });

  // ── PostgREST upsert (the write) ──
  for (const mode of [...HTTP_REFUSALS, ...HTTP_OUTAGES, ...TRANSPORT_FAULTS]) {
    add({
      target: "rest_upsert",
      mode,
      bearer: "session",
      expect: unavailable,
    });
  }
  add({
    target: "rest_upsert",
    mode: "timeout",
    bearer: "session",
    expect: unavailable,
    note: "PostgREST socket hangs on the write",
  });
  add({
    target: "rest_upsert",
    mode: "slow_ok",
    bearer: "session",
    slowMs: 300,
    expect: ok,
  });

  // ── PostgREST read-back (after the write landed) ──
  // postgrest-js (pinned 2.112.4) retries GET on 503/520 and on connect
  // errors up to 3× with 1 s / 2 s / 4 s backoff, so a single blip heals
  // inside the request and a sustained outage costs ~7 s before the 503.
  for (const mode of [...HTTP_REFUSALS, ...HTTP_OUTAGES, ...TRANSPORT_FAULTS]) {
    if (mode === "http_503") {
      add({
        target: "rest_select",
        mode,
        bearer: "session",
        variant: "blip",
        expect: ok,
        deadlineMs: 12_000,
        note: "one 503 on the read-back is retried by postgrest-js after 1 s",
      });
      add({
        target: "rest_select",
        mode,
        bearer: "session",
        variant: "sustained",
        count: Infinity,
        expect: unavailable,
        deadlineMs: 12_000,
        slow: true,
        note:
          "sustained 503: 3 hidden retries (1+2+4 s) before the user sees 503",
      });
      continue;
    }
    add({
      target: "rest_select",
      mode,
      bearer: "session",
      expect: unavailable,
      deadlineMs: mode === "network_error" ? 12_000 : undefined,
      count: mode === "network_error" ? Infinity : undefined,
      slow: mode === "network_error" ? true : undefined,
      note: mode === "network_error"
        ? "sustained connect failure: 3 hidden retries (1+2+4 s) before 503"
        : undefined,
    });
  }
  add({
    target: "rest_select",
    mode: "timeout",
    bearer: "session",
    expect: unavailable,
    note: "PostgREST socket hangs on the read-back",
  });

  // ── Upstash Redis (cache + shared rate limits) — every fault must fail open ──
  for (const mode of [...HTTP_REFUSALS, ...HTTP_OUTAGES, ...TRANSPORT_FAULTS]) {
    add({
      target: "redis",
      mode,
      bearer: "session",
      count: Infinity,
      expect: ok,
    });
  }
  add({
    target: "redis",
    mode: "redis_command_error",
    bearer: "session",
    count: Infinity,
    expect: ok,
  });
  add({
    target: "redis",
    mode: "redis_short_reply",
    bearer: "session",
    count: Infinity,
    expect: ok,
  });
  add({
    target: "redis",
    mode: "timeout",
    bearer: "session",
    count: Infinity,
    expect: ok,
    deadlineMs: 15_000,
    slow: true,
    note:
      "every Redis call must give up at REDIS_TIMEOUT_MS (1200 ms) and fail open",
  });

  // ── RevenueCat — not on this route; the fault must never be consumed ──
  add({
    target: "revenuecat",
    mode: "http_500",
    bearer: "session",
    count: Infinity,
    expect: ok,
    note: "saveDrill never consults RevenueCat",
  });
  return cases;
}

export const FAULT_CASES = buildCases();

/** Cases whose observed behaviour is pinned as a known divergence from
 * `expect`. Fixing the route makes this test fail until the id is removed. */
const KNOWN_DIVERGENCES: Record<string, string> = {
  // Transitional provider-token path: supabase-js folds every GoTrue failure
  // into one AuthError, so outages read as credential refusals (401).
  "gotrue_token/http_500/provider": "outage → 401 instead of 503",
  "gotrue_token/http_502/provider": "outage → 401 instead of 503",
  "gotrue_token/http_503/provider": "outage → 401 instead of 503",
  "gotrue_token/http_504/provider": "outage → 401 instead of 503",
  "gotrue_token/network_error/provider": "connect failure → 401 instead of 503",
  "gotrue_token/malformed_json/provider": "garbage body → 401 instead of 503",
  "gotrue_token/html_body/provider": "garbage body → 401 instead of 503",
  "gotrue_token/empty_body/provider": "garbage body → 401 instead of 503",
  "gotrue_token/wrong_shape/provider": "garbage body → 401 instead of 503",
  "gotrue_token/truncated_stream/provider": "garbage body → 401 instead of 503",
  "gotrue_token/timeout/provider":
    "no deadline on signInWithIdToken → request hangs",
  // No deadline on the PostgREST client: a hung socket hangs the request.
  "rest_upsert/timeout/session":
    "no deadline on PostgREST write → request hangs",
  "rest_select/timeout/session":
    "no deadline on PostgREST read-back → request hangs",
};

interface CaseResult {
  id: string;
  seed: number;
  target: Upstream;
  mode: FaultMode;
  bearer: Bearer;
  ip: string;
  slug: string;
  expect: FaultCase["expect"];
  observed: {
    status: number | "pending";
    klass: ErrorClass;
    message: string | null;
    retryAfter: string | null;
    ms: number;
    roundTrips: Record<string, number>;
    faultHits: number;
    upstreamCalls: Array<
      { kind: string; outcome: number | string; ms: number; fault?: string }
    >;
    leaks: string[];
  };
  recovery: {
    status: number | "pending";
    ms: number;
    rowSaved: boolean;
    roundTrips: Record<string, number>;
  };
  verdict: "HELD" | "BROKEN";
  knownDivergence: string | null;
  note: string | null;
  replay: string;
}

function classify(answer: Answer): ErrorClass {
  if (answer.status === "pending") return "hang";
  if (answer.status === 200) return "ok";
  if (answer.status === 401) return "auth_rejected";
  if (answer.status === 429) return "rate_limited";
  if (answer.status === 503) return "unavailable";
  return "unavailable";
}

function messageOf(answer: Answer): string | null {
  const err = answer.body.error;
  if (
    err && typeof err === "object" &&
    typeof (err as Record<string, unknown>).message === "string"
  ) {
    return (err as Record<string, string>).message;
  }
  return null;
}

/** A fresh identity + bearer for a case; warm bearers are verified once
 * against a healthy Auth first so the fault meets a cache hit. */
async function bearerFor(
  fake: FakeUpstreams,
  prng: Prng,
  kind: Bearer,
  ip: string,
): Promise<{
  userId: string | null;
  sub: string | null;
  token: string;
}> {
  const userId = prng.uuid();
  if (kind === "provider") {
    const sub = `google-${userId}`;
    return { userId: null, sub, token: fakeGoogleIdToken(sub) };
  }
  const session = fake.mintSession(userId);
  if (kind === "session_warm") {
    const warm = await drive(
      h,
      putSavedDrill(prng.slug(), { token: session.accessToken, ip }),
    );
    if (warm.status !== 200) throw new Error(`warm-up failed: ${warm.status}`);
  }
  return { userId, sub: null, token: session.accessToken };
}

async function runCase(c: FaultCase, seed: number): Promise<CaseResult> {
  const prng = new Prng(seed);
  const fake = h.fake;
  fake.clearFaults();
  fake.releaseHangs();
  const ip = prng.ip();
  const slug = prng.slug();
  const bearer = await bearerFor(fake, prng, c.bearer, ip);
  fake.arm({
    target: c.target,
    mode: c.mode,
    count: c.count,
    retryAfter: c.retryAfter,
    slowMs: c.slowMs,
  });
  const answer = await drive(
    h,
    putSavedDrill(slug, { token: bearer.token, ip }),
    c.deadlineMs ?? 2_000,
  );
  const faultHits = fake.faultHits().reduce((sum, f) => sum + f.hits, 0);
  fake.clearFaults();
  fake.releaseHangs();
  // Let a released handler settle before the recovery request is measured.
  if (answer.status === "pending") await sleep(20);

  const recovery = await drive(
    h,
    putSavedDrill(slug, { token: bearer.token, ip }),
    12_000,
  );
  const userId = bearer.userId ??
    (bearer.sub ? fake.identities.get(bearer.sub) ?? null : null);
  const rowSaved = userId !== null && fake.savedDrills.has(`${userId}|${slug}`);

  const observedKlass = classify(answer);
  const matches = answer.status === c.expect.status &&
    observedKlass === c.expect.klass;
  const known = KNOWN_DIVERGENCES[c.id] ?? null;
  return {
    id: c.id,
    seed,
    target: c.target,
    mode: c.mode,
    bearer: c.bearer,
    ip,
    slug,
    expect: c.expect,
    observed: {
      status: answer.status,
      klass: observedKlass,
      message: messageOf(answer),
      retryAfter: answer.headers["retry-after"] ?? null,
      ms: answer.ms,
      roundTrips: FakeUpstreams.tally(answer.calls),
      faultHits,
      upstreamCalls: answer.calls.map((call) => ({
        kind: call.kind,
        outcome: call.outcome,
        ms: call.ms,
        ...(call.fault ? { fault: call.fault } : {}),
      })),
      leaks: typeof answer.status === "number" && answer.status !== 200
        ? leaks(answer.body)
        : [],
    },
    recovery: {
      status: recovery.status,
      ms: recovery.ms,
      rowSaved,
      roundTrips: FakeUpstreams.tally(recovery.calls),
    },
    verdict: matches ? "HELD" : "BROKEN",
    knownDivergence: known,
    note: c.note ?? null,
    replay:
      `STRESS_SEED=${seed} STRESS_CASE='${c.id}' STRESS_AUTH_TIMEOUT_MS=${AUTH_TIMEOUT_MS} deno test -A --no-check --config deno.json stress_saved_drill_put_faults.test.ts`,
  };
}

Deno.test({
  name:
    "stress/saved-drill PUT: every upstream fault maps to a safe user-visible class and recovers",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const only = Deno.env.get("STRESS_CASE");
    const includeSlow = Deno.env.get("STRESS_SLOW") === "1";
    const selected = only
      ? FAULT_CASES.filter((c) => c.id === only)
      : FAULT_CASES.filter((c) => includeSlow || !c.slow);
    if (selected.length === 0) {
      throw new Error(`STRESS_CASE ${only} matches no fault case`);
    }
    const skippedSlow = FAULT_CASES.filter((c) => !selected.includes(c)).map((
      c,
    ) => c.id);

    h.fake.reset(STRESS_SEED);
    const results: CaseResult[] = [];
    const failures: string[] = [];
    for (const [index, c] of selected.entries()) {
      const seed = (STRESS_SEED + index * 7919) >>> 0;
      const r = await runCase(c, seed);
      results.push(r);

      // Envelope every case must respect, whatever its class.
      if (r.observed.status === 500) {
        failures.push(`${r.id}: handler answered 500`);
      }
      if (r.observed.leaks.length) {
        failures.push(
          `${r.id}: error body leaks ${r.observed.leaks.join(",")}`,
        );
      }
      if (r.observed.status === 429 && r.observed.retryAfter === null) {
        failures.push(`${r.id}: 429 without Retry-After`);
      }
      if (r.recovery.status !== 200 || !r.recovery.rowSaved) {
        failures.push(
          `${r.id}: did not recover (status ${r.recovery.status}, rowSaved=${r.recovery.rowSaved})`,
        );
      }
      if (c.target === "revenuecat" && r.observed.faultHits !== 0) {
        failures.push(
          `${r.id}: route reached RevenueCat (${r.observed.faultHits} calls)`,
        );
      }
      if (c.bearer === "session_warm" && r.observed.roundTrips.gotrue !== 0) {
        failures.push(
          `${r.id}: warm bearer re-verified against Auth during outage`,
        );
      }
      if (c.target === "redis" && r.observed.status !== 200) {
        failures.push(
          `${r.id}: Redis fault did not fail open (status ${r.observed.status})`,
        );
      }
      // Expected class, unless pinned as a known divergence.
      if (r.verdict === "BROKEN" && !r.knownDivergence) {
        failures.push(
          `${r.id}: expected ${r.expect.status}/${r.expect.klass}, observed ${r.observed.status}/${r.observed.klass} (${
            r.observed.message ?? "no message"
          }) — replay: ${r.replay}`,
        );
      }
      if (r.verdict === "HELD" && r.knownDivergence) {
        failures.push(
          `${r.id}: pinned divergence no longer reproduces — remove it from KNOWN_DIVERGENCES`,
        );
      }
    }

    const summary = {
      unit: "route-put-v1-me-saved-drills-slug",
      lens: "failure-load/faults",
      seed: STRESS_SEED,
      authTimeoutMs: AUTH_TIMEOUT_MS,
      redisConfigured: h.redisConfigured,
      cases: results.length,
      /** Not run in this invocation (STRESS_SLOW=1 runs them) — not passes. */
      skippedSlow,
      held: results.filter((r) => r.verdict === "HELD").length,
      broken: results.filter((r) => r.verdict === "BROKEN").map((r) => r.id),
      byClass: results.reduce<Record<string, number>>((acc, r) => {
        acc[r.observed.klass] = (acc[r.observed.klass] ?? 0) + 1;
        return acc;
      }, {}),
      revenuecatCalls: h.fake.counters["revenuecat"] ?? 0,
      /** Which upstream's 503 carries Retry-After (Auth does, PostgREST does not). */
      retryAfterOn503: results
        .filter((r) => r.observed.status === 503)
        .reduce<Record<string, { with: number; without: number }>>((acc, r) => {
          const slot = acc[r.target] ??
            (acc[r.target] = { with: 0, without: 0 });
          if (r.observed.retryAfter === null) slot.without += 1;
          else slot.with += 1;
          return acc;
        }, {}),
      failures,
      results,
    };
    const path = await writeArtifact(
      only ? `faults_${only.replace(/[^A-Za-z0-9_-]+/g, "_")}` : "faults",
      summary,
    );
    console.log(
      `[stress] faults: ${summary.held}/${summary.cases} held → ${path}`,
    );
    if (failures.length) {
      throw new Error(`fault matrix violations:\n${failures.join("\n")}`);
    }
  },
});

Deno.test({
  name:
    "stress/saved-drill PUT: Auth outage on the transitional provider path burns the auth-failure budget",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // 30 auth failures per IP per 5 min lock the IP out (429). A GoTrue OUTAGE
    // should not count as failures — this pins whether it does.
    const seed = (STRESS_SEED ^ 0xa5a5) >>> 0;
    const prng = new Prng(seed);
    h.fake.reset(seed);
    const ip = prng.ip();
    h.fake.arm({ target: "gotrue_token", mode: "http_503", count: Infinity });
    const statuses: Array<number | "pending"> = [];
    for (let i = 0; i < 32; i++) {
      const token = fakeGoogleIdToken(`google-${prng.uuid()}`);
      statuses.push(
        (await drive(h, putSavedDrill(prng.slug(), { token, ip }))).status,
      );
    }
    h.fake.clearFaults();
    // Outage over: a brand-new legitimate user on that IP.
    const fresh = await drive(
      h,
      putSavedDrill("dink-drill", {
        token: fakeGoogleIdToken(`google-${prng.uuid()}`),
        ip,
      }),
    );

    // HELD counterpart: the production session-bearer path during the same
    // outage answers 503 and charges nothing — the IP recovers immediately.
    const ip2 = prng.ip();
    h.fake.arm({ target: "gotrue_user", mode: "http_503", count: Infinity });
    const sessionStatuses: Array<number | "pending"> = [];
    for (let i = 0; i < 32; i++) {
      const token = h.fake.mintSession(prng.uuid()).accessToken;
      sessionStatuses.push(
        (await drive(h, putSavedDrill(prng.slug(), { token, ip: ip2 }))).status,
      );
    }
    h.fake.clearFaults();
    const fresh2 = await drive(
      h,
      putSavedDrill("dink-drill", {
        token: h.fake.mintSession(prng.uuid()).accessToken,
        ip: ip2,
      }),
    );

    const tally = (list: Array<number | "pending">) =>
      list.reduce<Record<string, number>>((acc, s) => {
        acc[String(s)] = (acc[String(s)] ?? 0) + 1;
        return acc;
      }, {});
    const report = {
      seed,
      provider: {
        ip,
        duringOutage: tally(statuses),
        afterRecovery: {
          status: fresh.status,
          retryAfter: fresh.headers["retry-after"] ?? null,
          body: fresh.body,
        },
        verdict: "BROKEN",
      },
      session: {
        ip: ip2,
        duringOutage: tally(sessionStatuses),
        afterRecovery: { status: fresh2.status, body: fresh2.body },
        verdict: sessionStatuses.every((s) =>
            s === 503
          ) && fresh2.status === 200
          ? "HELD"
          : "BROKEN",
      },
      replay:
        `STRESS_SEED=${STRESS_SEED} deno test -A --no-check --config deno.json --filter "auth-failure budget" stress_saved_drill_put_faults.test.ts`,
    };
    const path = await writeArtifact("faults_auth_outage_budget", report);
    console.log(`[stress] auth outage budget → ${path}`);
    if (report.session.verdict !== "HELD") {
      throw new Error(
        `session path during Auth outage: ${JSON.stringify(report.session)}`,
      );
    }
    // Pinned divergence (same root cause as gotrue_token/*/provider): outage
    // answers are 401s, the 31st+ becomes 429, and once Auth is back the IP
    // stays locked out for the rest of the 5-minute window.
    if (
      !(statuses.slice(0, 30).every((s) => s === 401) &&
        statuses.slice(30).every((s) => s === 429))
    ) {
      throw new Error(
        `pinned behaviour changed: ${
          JSON.stringify(report.provider.duringOutage)
        } — update the finding`,
      );
    }
    if (fresh.status !== 429) {
      throw new Error(
        `pinned behaviour changed: post-outage request answered ${fresh.status}`,
      );
    }
  },
});
