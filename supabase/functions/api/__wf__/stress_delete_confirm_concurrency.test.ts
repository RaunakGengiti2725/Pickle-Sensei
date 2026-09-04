/**
 * stress-route-post-v1-me-delete-confirm / lens CONCURRENCY — in-process
 * campaign against the REAL `POST /v1/me/delete-confirm` handler
 * (supabase/functions/api/index.ts) over the modelled Supabase / RevenueCat /
 * Apple world in ./stress_delete_confirm_harness.ts.
 *
 *   deno test -A --no-check --config deno.json stress_delete_confirm_concurrency.test.ts
 *
 *   STRESS_ITER=500        iterations (default 40 — fast enough for the suite)
 *   STRESS_SEED=<n>        campaign seed (default 20260904)
 *   STRESS_LATENCY_MS=<n>  max seeded latency per upstream call (default 6)
 *   STRESS_REPLAY=<seed>   run ONLY the iteration(s) with these iteration seeds
 *   STRESS_KIND=<kind>     restrict the campaign to one scenario kind
 *   STRESS_OUT_DIR=<dir>   where the JSON table (seed → outcome) is written
 *
 * Every iteration derives its own seed from (STRESS_SEED, index); the seed
 * alone reproduces the actors, the burst shape, the injected faults and every
 * upstream latency (the fake's PRNG is re-seeded from it), so a BROKEN row is
 * replayed with `STRESS_REPLAY=<iteration seed>`.
 *
 * Scenario kinds (weights in KINDS):
 *   dup_burst           k∈[2,5] identical confirms in one Promise.all
 *   dup_over_budget     k∈[6,8] — the 5/hour per-user budget must admit ≤5
 *   cancel_retry        client abandons the call and re-sends while it is in
 *                       flight (staggered duplicates, seeded gaps)
 *   confirm_vs_rearm    confirm(X) racing delete-request (re-arms challenge Y)
 *   confirm_vs_logout   confirm racing logout of the SAME session
 *   confirm_vs_refresh  confirm racing a refresh rotation of the same session
 *   cross_actor         user B presents user A's challenge while A confirms
 *   clock_skew          created_at written by a skewed isolate (−20 s … +20 s)
 *   fault_retry         transient Apple / RevenueCat / GoTrue-admin failures,
 *                       then the client's sequential retries
 *
 * Invariants (all kinds): bounded wall time (no deadlock), never 5xx except
 * the injected-fault 503s, exactly one effective deletion, every 200 did
 * exactly one deleteUser and no request that did not answer 200 deleted
 * anything, no orphan rows after the cascade, the deleting session's bearers
 * are refused afterwards WITHOUT consulting GoTrue (fence), free-rating /
 * RevenueCat side effects never exceed what the 200s account for, cross-user
 * challenges never delete anyone.
 */
import { assert } from "@std/assert";
import { envInt, histogram, Prng, sleep } from "./xc_concurrency_harness.ts";
import {
  accessProbe,
  type Actor,
  type Answer,
  confirmRequest,
  type DeleteConfirmHarness,
  loadDeleteConfirmWorld,
  logoutRequest,
  mintActor,
  refreshRequest,
  requestDeletionRequest,
  timedCall,
} from "./stress_delete_confirm_harness.ts";

const STRESS_ITER = envInt("STRESS_ITER", 40);
const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 6);
const STRESS_REPLAY = (Deno.env.get("STRESS_REPLAY") ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const STRESS_KIND = Deno.env.get("STRESS_KIND") ?? "";
const DEADLINE_MS = 5_000;
const DELETE_CONFIRM_BUDGET = 5;
const MIN_AGE_MS = 3_000;

type Kind =
  | "dup_burst"
  | "dup_over_budget"
  | "cancel_retry"
  | "confirm_vs_rearm"
  | "confirm_vs_logout"
  | "confirm_vs_refresh"
  | "cross_actor"
  | "clock_skew"
  | "fault_retry";

const KINDS: Array<[Kind, number]> = [
  ["dup_burst", 20],
  ["dup_over_budget", 10],
  ["cancel_retry", 10],
  ["confirm_vs_rearm", 12],
  ["confirm_vs_logout", 12],
  ["confirm_vs_refresh", 10],
  ["cross_actor", 10],
  ["clock_skew", 8],
  ["fault_retry", 8],
];

interface Check {
  name: string;
  holds: boolean;
  detail: string;
}

interface IterationRow {
  index: number;
  seed: number;
  kind: Kind;
  outcome: "HELD" | "BROKEN";
  shape: Record<string, unknown>;
  statuses: string[];
  failed: string[];
  checks: number;
  durationMs: number;
  replay: string;
  /** BROKEN rows only: every upstream call and the model's own event log */
  evidence?: { upstream: unknown[]; timeline: unknown[] };
}

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-delete-confirm/latest/", import.meta.url).pathname;
}

function iterationSeed(index: number): number {
  // splitmix-style mix of (campaign seed, index) → a distinct 31-bit seed
  let z = (STRESS_SEED + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return ((z ^ (z >>> 16)) >>> 0) % 2_147_483_647 || 1;
}

function pickKind(prng: Prng): Kind {
  const total = KINDS.reduce((n, [, w]) => n + w, 0);
  let roll = prng.int(1, total);
  for (const [kind, weight] of KINDS) {
    roll -= weight;
    if (roll <= 0) return kind;
  }
  return KINDS[KINDS.length - 1][0];
}

function replayCommand(seed: number, kind: Kind): string {
  return `STRESS_REPLAY=${seed} STRESS_KIND=${kind} STRESS_SEED=${STRESS_SEED} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json stress_delete_confirm_concurrency.test.ts`;
}

class Ctx {
  checks: Check[] = [];
  answers: Answer[] = [];
  private ipCounter = 0;
  constructor(
    public h: DeleteConfirmHarness,
    public prng: Prng,
    public seed: number,
    public shape: Record<string, unknown>,
  ) {}
  /** unique client IP per request so per-IP budgets never couple iterations */
  ip(): string {
    this.ipCounter += 1;
    const s = this.seed;
    return `10.${(s >>> 16) & 255}.${(s >>> 8) & 255}.${this.ipCounter & 255}`;
  }
  check(name: string, holds: boolean, detail: string): void {
    this.checks.push({ name, holds, detail });
  }
  async call(op: string, request: Request): Promise<Answer> {
    const a = await timedCall(this.h, op, request, DEADLINE_MS);
    this.answers.push(a);
    return a;
  }
  world() {
    return this.h.world;
  }
}

const summary = (answers: Answer[]) =>
  answers.map((a) => `${a.op}:${a.status}${a.code ? `/${a.code}` : ""}`).join(" ");

const is5xx = (a: Answer) => a.status >= 500;

/** Post-deletion contract shared by every kind that deleted the account. */
async function assertDeleted(ctx: Ctx, actor: Actor, label: string, tokens: string[]) {
  const w = ctx.world();
  const c = w.counters(actor.userId);
  ctx.check(
    `${label}: auth user gone`,
    !w.userExists(actor.userId),
    `exists=${
      w.userExists(
        actor.userId,
      )
    }`,
  );
  const orphans = w.orphanRows(actor.userId);
  ctx.check(
    `${label}: no orphan rows for the deleted user (cascade + no late writes)`,
    orphans.length === 0,
    orphans.map((o) => `${o.table}:${JSON.stringify(o.row)}`).join(" | ") || "none",
  );
  ctx.check(
    `${label}: RevenueCat customer deleted exactly once`,
    c.rcDeleteOk === 1 && !w.rcCustomers.has(actor.userId),
    `rcDeleteOk=${c.rcDeleteOk} rc404=${c.rcDelete404} stillCustomer=${
      w.rcCustomers.has(
        actor.userId,
      )
    }`,
  );
  ctx.check(
    `${label}: deleteUser effective exactly once`,
    c.adminDeleteOk === 1,
    `adminDeleteOk=${c.adminDeleteOk} admin404=${c.adminDelete404}`,
  );
  // Every bearer of the deleting session must now be refused at the fence,
  // i.e. without a GoTrue round trip (the marker is keyed by session_id).
  const before = c.getUser;
  const probes = await Promise.all(
    tokens.map((token, i) => ctx.call(`probe.${i}`, accessProbe(token, ctx.ip()))),
  );
  ctx.check(
    `${label}: every bearer of the deleting session is refused (401) after deletion`,
    probes.every((p) => p.status === 401),
    summary(probes),
  );
  ctx.check(
    `${label}: post-deletion probes never consult GoTrue (session fence hit)`,
    c.getUser === before,
    `getUser calls during probes: ${c.getUser - before}`,
  );
}

function assertNoSideEffects(ctx: Ctx, actor: Actor, label: string) {
  const w = ctx.world();
  const c = w.counters(actor.userId);
  ctx.check(
    `${label}: user intact and no deletion side effect ran`,
    w.userExists(actor.userId) &&
      c.adminDelete === 0 &&
      c.rcDelete === 0 &&
      c.appleRevoke === 0 &&
      w.rcCustomers.has(actor.userId),
    `exists=${
      w.userExists(actor.userId)
    } admin=${c.adminDelete} rc=${c.rcDelete} apple=${c.appleRevoke}`,
  );
}

function assertAccounting(ctx: Ctx, actor: Actor, answers: Answer[], label: string) {
  const c = ctx.world().counters(actor.userId);
  const n200 = answers.filter((a) => a.status === 200).length;
  ctx.check(
    `${label}: deleteUser calls == number of 200s (a non-200 never deleted, a 200 always did)`,
    c.adminDelete === n200,
    `adminDelete=${c.adminDelete} n200=${n200} ${summary(answers)}`,
  );
  ctx.check(
    `${label}: every 200 body is {deleted:true}`,
    answers.filter((a) => a.status === 200).every((a) => a.body.deleted === true),
    answers
      .filter((a) => a.status === 200)
      .map((a) => JSON.stringify(a.body))
      .join(" "),
  );
}

// ── kinds ────────────────────────────────────────────────────────────────────

async function dupBurst(ctx: Ctx, k: number, staggerMaxMs: number) {
  const apple = ctx.prng.int(0, 1) === 1;
  const actor = await mintActor(ctx.world(), ctx.prng, {
    provider: apple ? "apple" : "google",
    appleToken: apple && ctx.prng.int(0, 3) > 0,
  });
  ctx.shape.k = k;
  ctx.shape.provider = actor.provider;
  ctx.shape.staggerMaxMs = staggerMaxMs;
  const gaps = Array.from(
    { length: k },
    () => (staggerMaxMs > 0 ? ctx.prng.int(0, staggerMaxMs) : 0),
  );
  ctx.shape.gaps = gaps;
  const t0 = performance.now();
  const answers = await Promise.all(
    gaps.map(async (gap, i) => {
      if (gap > 0) await sleep(gap);
      return ctx.call(`confirm.${i}`, confirmRequest(actor, ctx.ip()));
    }),
  );
  const wall = performance.now() - t0;
  ctx.check(
    "burst finished inside the deadline (no deadlock)",
    answers.every((a) => !a.timedOut) &&
      wall < DEADLINE_MS,
    `wall=${Math.round(wall)}ms`,
  );
  const admitted = answers.filter((a) => a.status !== 429);
  ctx.check(
    `per-user budget admits ≤ ${DELETE_CONFIRM_BUDGET} of ${k} identical confirms`,
    admitted.length === Math.min(k, DELETE_CONFIRM_BUDGET),
    summary(answers),
  );
  const c = ctx.world().counters(actor.userId);
  ctx.shape.fk23503 = c.fkViolations;
  ctx.check(
    "idempotent duplicate delivery: no 5xx among duplicates",
    !answers.some(is5xx),
    `${summary(answers)} fk23503=${c.fkViolations}`,
  );
  ctx.check(
    "every 503 is the RC-checkpoint upsert hitting the cascaded FK (23503) — no other 5xx cause",
    answers.filter(is5xx).every((a) => a.status === 503) &&
      answers.filter(is5xx).length === c.fkViolations,
    `${summary(answers)} fk23503=${c.fkViolations}`,
  );
  ctx.check(
    "at least one duplicate answered 200 {deleted:true}",
    answers.some(
      (a) => a.status === 200 && a.body.deleted === true,
    ),
    summary(answers),
  );
  ctx.check(
    "every non-200, non-503 duplicate is 429 (budget), 401 (fenced session) or 403 deletion_challenge_invalid (row cascaded)",
    answers.every(
      (a) =>
        a.status === 200 ||
        a.status === 503 ||
        a.status === 429 ||
        a.status === 401 ||
        (a.status === 403 && a.code === "account.deletion_challenge_invalid"),
    ),
    summary(answers),
  );
  ctx.shape.dup403AfterCascade = answers.filter(
    (a) => a.status === 403 && a.code === "account.deletion_challenge_invalid",
  ).length;
  ctx.shape.dup401Fenced = answers.filter((a) => a.status === 401).length;
  assertAccounting(ctx, actor, answers, "dup");
  if (actor.provider === "apple") {
    const outcomes = answers
      .filter((a) => a.status === 200)
      .map((a) => String(a.body.appleAuthorizationRevocation));
    ctx.check(
      "apple: every 200 reports the same authorization outcome",
      new Set(outcomes).size <= 1,
      outcomes.join(","),
    );
  }
  await assertDeleted(ctx, actor, "dup", [actor.accessToken]);
}

async function confirmVsRearm(ctx: Ctx) {
  const actor = await mintActor(ctx.world(), ctx.prng);
  const gap = ctx.prng.int(0, 25);
  const rearmFirst = ctx.prng.int(0, 1) === 1;
  ctx.shape.gapMs = gap;
  ctx.shape.rearmFirst = rearmFirst;
  const [confirm, rearm] = await Promise.all([
    (async () => {
      if (!rearmFirst && gap) await sleep(gap);
      return ctx.call("confirm", confirmRequest(actor, ctx.ip()));
    })(),
    (async () => {
      if (rearmFirst && gap) await sleep(gap);
      return ctx.call("rearm", requestDeletionRequest(actor, ctx.ip()));
    })(),
  ]);
  ctx.check("no timeouts", !confirm.timedOut && !rearm.timedOut, summary(ctx.answers));
  ctx.check(
    "confirm answered 200 or 403 challenge_invalid (re-armed first) — never 5xx",
    confirm.status === 200 ||
      (confirm.status === 403 && confirm.code === "account.deletion_challenge_invalid"),
    summary(
      ctx.answers,
    ),
  );
  const rows = ctx.world().fake.tables.account_deletion_requests.filter((r) =>
    r.user_id === actor.userId
  );
  if (confirm.status === 200) {
    await assertDeleted(ctx, actor, "rearm-race", [actor.accessToken]);
    ctx.check(
      "delete-request racing the deletion: 200 (landed first) / 401 (fenced) / 503 (upsert hit the cascaded FK) — never 200 with a row left behind",
      (rearm.status === 200 && rows.length === 0) || rearm.status === 401 || rearm.status === 503,
      `rearm=${rearm.status}/${rearm.code} rowsAfter=${rows.length}`,
    );
  } else {
    assertNoSideEffects(ctx, actor, "rearm-race(403)");
    ctx.check(
      "re-arm landed first: exactly one pending row with the NEW challenge",
      rearm.status === 200 &&
        rows.length === 1 &&
        rows[0].challenge === rearm.body.challenge &&
        rows[0].challenge !== actor.challenge,
      `rearm=${rearm.status} rows=${JSON.stringify(rows)}`,
    );
  }
}

async function confirmVsLogout(ctx: Ctx) {
  const actor = await mintActor(ctx.world(), ctx.prng);
  const gap = ctx.prng.int(0, 25);
  const logoutFirst = ctx.prng.int(0, 1) === 1;
  ctx.shape.gapMs = gap;
  ctx.shape.logoutFirst = logoutFirst;
  const [confirm, logout] = await Promise.all([
    (async () => {
      if (!logoutFirst && gap) await sleep(gap);
      return ctx.call("confirm", confirmRequest(actor, ctx.ip()));
    })(),
    (async () => {
      if (logoutFirst && gap) await sleep(gap);
      return ctx.call("logout", logoutRequest(actor, ctx.ip()));
    })(),
  ]);
  ctx.check("no timeouts", !confirm.timedOut && !logout.timedOut, summary(ctx.answers));
  ctx.check(
    "confirm answered 200 or 401 — never 5xx",
    confirm.status === 200 || confirm.status === 401,
    summary(
      ctx.answers,
    ),
  );
  ctx.check(
    "logout answered 204 or 401",
    logout.status === 204 || logout.status === 401,
    summary(ctx.answers),
  );
  if (confirm.status === 200) {
    await assertDeleted(ctx, actor, "logout-race", [actor.accessToken]);
  } else {
    assertNoSideEffects(ctx, actor, "logout-race(401)");
    const session = ctx.world().fake.sessions.get(actor.sessionId);
    ctx.check(
      "401 confirm implies the session was revoked upstream first",
      session?.revoked === true,
      `revoked=${session?.revoked}`,
    );
  }
}

async function confirmVsRefresh(ctx: Ctx) {
  const actor = await mintActor(ctx.world(), ctx.prng);
  const gap = ctx.prng.int(0, 25);
  const refreshFirst = ctx.prng.int(0, 1) === 1;
  ctx.shape.gapMs = gap;
  ctx.shape.refreshFirst = refreshFirst;
  const [confirm, refresh] = await Promise.all([
    (async () => {
      if (!refreshFirst && gap) await sleep(gap);
      return ctx.call("confirm", confirmRequest(actor, ctx.ip()));
    })(),
    (async () => {
      if (refreshFirst && gap) await sleep(gap);
      return ctx.call("refresh", refreshRequest(actor, ctx.ip()));
    })(),
  ]);
  ctx.check("no timeouts", !confirm.timedOut && !refresh.timedOut, summary(ctx.answers));
  ctx.check(
    "confirm 200 (a rotation never invalidates the in-flight access token)",
    confirm.status === 200,
    summary(
      ctx.answers,
    ),
  );
  ctx.check(
    "refresh 200 (rotated before the cascade) or 401 (session gone) — never 5xx",
    refresh.status === 200 || refresh.status === 401,
    summary(
      ctx.answers,
    ),
  );
  const tokens = [actor.accessToken];
  const session = refresh.body.session;
  if (refresh.status === 200 && session && typeof session === "object") {
    const rotated = (session as Record<string, unknown>).accessToken;
    if (typeof rotated === "string") tokens.push(rotated);
  }
  ctx.shape.rotatedTokenProbed = tokens.length === 2;
  await assertDeleted(ctx, actor, "refresh-race", tokens);
}

async function crossActor(ctx: Ctx) {
  const a = await mintActor(ctx.world(), ctx.prng);
  const b = await mintActor(ctx.world(), ctx.prng);
  const k = ctx.prng.int(1, 3);
  ctx.shape.kB = k;
  const answers = await Promise.all([
    ctx.call("A.confirm", confirmRequest(a, ctx.ip())),
    ...Array.from(
      { length: k },
      (_, i) => ctx.call(`B.confirm.withA.${i}`, confirmRequest(b, ctx.ip(), a.challenge)),
    ),
  ]);
  const [aAnswer, ...bAnswers] = answers;
  ctx.check("no timeouts", answers.every((x) => !x.timedOut), summary(answers));
  ctx.check("A's confirm 200", aAnswer.status === 200, summary(answers));
  ctx.check(
    "B presenting A's challenge is always 403 deletion_challenge_invalid",
    bAnswers.every((x) => x.status === 403 && x.code === "account.deletion_challenge_invalid"),
    summary(bAnswers),
  );
  assertNoSideEffects(ctx, b, "cross-actor B");
  const bRows = ctx.world().fake.tables.account_deletion_requests.filter((r) =>
    r.user_id === b.userId
  );
  ctx.check(
    "B's own pending challenge untouched",
    bRows.length === 1 && bRows[0].challenge === b.challenge,
    JSON.stringify(bRows),
  );
  await assertDeleted(ctx, a, "cross-actor A", [a.accessToken]);
  // B can still confirm with its OWN challenge afterwards
  const own = await ctx.call("B.confirm.own", confirmRequest(b, ctx.ip()));
  ctx.check(
    "B confirms with its own challenge afterwards → 200",
    own.status === 200 && own.body.deleted === true,
    summary([own]),
  );
}

async function clockSkew(ctx: Ctx) {
  // created_at as written by an isolate whose clock is `skew` ms ahead
  // (positive) or behind (negative) of ours; a legit user pressed confirm
  // `pressAfterMs` after the request was written (their own clock).
  const skewMs = ctx.prng.int(-20_000, 20_000);
  const pressAfterMs = ctx.prng.int(0, 8_000);
  const ageMs = pressAfterMs - skewMs;
  const actor = await mintActor(ctx.world(), ctx.prng, { requestAgeMs: ageMs });
  ctx.shape.skewMs = skewMs;
  ctx.shape.pressAfterMs = pressAfterMs;
  ctx.shape.effectiveAgeMs = ageMs;
  const k = ctx.prng.int(1, 2);
  ctx.shape.k = k;
  const before = Date.now();
  const answers = await Promise.all(
    Array.from({ length: k }, (_, i) => ctx.call(`confirm.${i}`, confirmRequest(actor, ctx.ip()))),
  );
  const after = Date.now();
  ctx.check(
    "no timeouts / no 5xx",
    answers.every((a) => !a.timedOut && !is5xx(a)),
    summary(answers),
  );
  const nearBoundary = Math.abs(ageMs - MIN_AGE_MS) <= (after - before) + 50;
  const expectTooFast = ageMs < MIN_AGE_MS;
  if (expectTooFast) {
    ctx.check(
      "request younger than 3 s (on our clock) → every confirm 429 deletion_too_fast, nothing deleted",
      nearBoundary ||
        answers.every((a) => a.status === 429 && a.code === "account.deletion_too_fast"),
      summary(answers),
    );
    assertNoSideEffects(ctx, actor, "skew(too_fast)");
    // The user is never stuck: once our clock passes created_at + 3 s the
    // same challenge is accepted (bounded wait; skip if it would exceed 1.5 s).
    const waitMs = MIN_AGE_MS - ageMs + 30;
    if (waitMs <= 1_500) {
      await sleep(waitMs);
      const retry = await ctx.call("confirm.after_wait", confirmRequest(actor, ctx.ip()));
      ctx.check(
        "same challenge accepted once the min age has passed",
        retry.status === 200 && retry.body.deleted === true,
        summary([retry]),
      );
      await assertDeleted(ctx, actor, "skew(after_wait)", [actor.accessToken]);
    } else {
      ctx.shape.retrySkipped = `would wait ${waitMs}ms`;
    }
  } else {
    ctx.check(
      "request ≥ 3 s old → one 200 and the rest 401/403(challenge_invalid), never 429",
      nearBoundary ||
        (answers.some((a) => a.status === 200) &&
          answers.every(
            (a) =>
              a.status === 200 ||
              a.status === 401 ||
              (a.status === 403 && a.code === "account.deletion_challenge_invalid"),
          )),
      summary(answers),
    );
    if (answers.some((a) => a.status === 200)) {
      assertAccounting(ctx, actor, answers, "skew");
      await assertDeleted(ctx, actor, "skew", [actor.accessToken]);
    }
  }
}

async function faultRetry(ctx: Ctx) {
  const w = ctx.world();
  const apple = ctx.prng.int(0, 1) === 1;
  const actor = await mintActor(w, ctx.prng, {
    provider: apple ? "apple" : "google",
    appleToken: apple,
  });
  // Up to three injected transient failures spread over Apple / RC / admin,
  // then the client retries sequentially (what the app does on 503).
  const nApple = apple ? ctx.prng.int(0, 1) : 0;
  const nRc = ctx.prng.int(0, 1);
  const nAdmin = ctx.prng.int(0, 1);
  w.faults.apple = Array.from({ length: nApple }, () => [500, 429, 503][ctx.prng.int(0, 2)]);
  w.faults.rc = Array.from({ length: nRc }, () => [500, 429, 503][ctx.prng.int(0, 2)]);
  w.faults.admin = Array.from({ length: nAdmin }, () => [500, 502][ctx.prng.int(0, 1)]);
  const concurrentFirst = ctx.prng.int(0, 1) === 1;
  ctx.shape.provider = actor.provider;
  ctx.shape.faults = {
    apple: [...w.faults.apple],
    rc: [...w.faults.rc],
    admin: [...w.faults.admin],
  };
  ctx.shape.concurrentFirst = concurrentFirst;

  const answers: Answer[] = [];
  if (concurrentFirst) {
    answers.push(
      ...(await Promise.all([
        ctx.call("confirm.0", confirmRequest(actor, ctx.ip())),
        ctx.call("confirm.1", confirmRequest(actor, ctx.ip())),
      ])),
    );
  } else {
    answers.push(await ctx.call("confirm.0", confirmRequest(actor, ctx.ip())));
  }
  let attempts = answers.length;
  while (!answers.some((a) => a.status === 200) && attempts < DELETE_CONFIRM_BUDGET) {
    attempts += 1;
    answers.push(await ctx.call(`confirm.retry.${attempts}`, confirmRequest(actor, ctx.ip())));
  }
  ctx.check("no timeouts", answers.every((a) => !a.timedOut), summary(answers));
  ctx.check(
    "every 5xx is a 503 carrying the retryable envelope (fail closed, retry later)",
    answers.filter(is5xx).every((a) => a.status === 503),
    summary(answers),
  );
  const injected = nApple + nRc + nAdmin;
  const c = w.counters(actor.userId);
  ctx.shape.fk23503 = c.fkViolations;
  ctx.check(
    `at most ${injected} requests failed (one per injected fault) and the client reached 200 within budget`,
    answers.filter((a) => a.status === 503).length <= injected &&
      answers.some((a) => a.status === 200),
    `${summary(answers)} fk23503=${c.fkViolations}`,
  );
  ctx.check(
    "every 503 beyond the injected faults is the RC-checkpoint upsert hitting the cascaded FK (23503)",
    answers.filter((a) => a.status === 503).length <= injected + c.fkViolations,
    `${summary(answers)} fk23503=${c.fkViolations}`,
  );
  // A 503 caused by RC/Apple never reached deleteUser; a 503 caused by the
  // admin fault did (that call is counted but had no effect).
  ctx.check(
    "deleteUser attempts == 200s + injected admin faults consumed",
    c.adminDelete ===
      answers.filter((a) => a.status === 200).length + (nAdmin - w.faults.admin.length),
    `adminDelete=${c.adminDelete} adminOk=${c.adminDeleteOk} ${summary(answers)}`,
  );
  if (apple) {
    // Once Apple accepted the revocation the checkpoint must stop any retry
    // from revoking again (sequential retries only — a concurrent sibling may
    // legitimately read the row before the checkpoint lands).
    const okThenRetries = c.appleRevokeOk;
    ctx.check(
      "apple revoked at most once per concurrent lane (checkpoint honoured by every sequential retry)",
      okThenRetries <= (concurrentFirst ? 2 : 1),
      `appleRevokeOk=${okThenRetries} appleRevoke=${c.appleRevoke}`,
    );
  }
  ctx.check(
    "RevenueCat deleted once; retries after the checkpoint never re-call RC",
    c.rcDeleteOk === 1 && c.rcDelete <= nRc + (concurrentFirst ? 2 : 1),
    `rcDelete=${c.rcDelete} rcOk=${c.rcDeleteOk} rc404=${c.rcDelete404}`,
  );
  await assertDeleted(ctx, actor, "fault-retry", [actor.accessToken]);
}

function runKind(ctx: Ctx, kind: Kind): Promise<void> {
  switch (kind) {
    case "dup_burst":
      return dupBurst(ctx, ctx.prng.int(2, 5), 0);
    case "dup_over_budget":
      return dupBurst(ctx, ctx.prng.int(6, 8), 0);
    case "cancel_retry":
      return dupBurst(ctx, ctx.prng.int(2, 3), 40);
    case "confirm_vs_rearm":
      return confirmVsRearm(ctx);
    case "confirm_vs_logout":
      return confirmVsLogout(ctx);
    case "confirm_vs_refresh":
      return confirmVsRefresh(ctx);
    case "cross_actor":
      return crossActor(ctx);
    case "clock_skew":
      return clockSkew(ctx);
    case "fault_retry":
      return faultRetry(ctx);
  }
}

async function runIteration(
  h: DeleteConfirmHarness,
  index: number,
  seed: number,
): Promise<IterationRow> {
  const prng = new Prng(seed);
  const kind = (STRESS_KIND as Kind) || pickKind(prng);
  h.world.reset(seed, STRESS_LATENCY_MS);
  const ctx = new Ctx(h, prng, seed, {});
  const t0 = performance.now();
  try {
    await runKind(ctx, kind);
  } catch (error) {
    ctx.check(
      "iteration threw",
      false,
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
  }
  const failed = ctx.checks.filter((c) => !c.holds).map((c) => `${c.name} — ${c.detail}`);
  const evidence = failed.length
    ? { upstream: [...h.world.calls], timeline: [...h.world.fake.timeline] }
    : undefined;
  return {
    index,
    seed,
    kind,
    outcome: failed.length === 0 ? "HELD" : "BROKEN",
    shape: ctx.shape,
    statuses: ctx.answers.map((a) => `${a.op}:${a.status}${a.code ? `/${a.code}` : ""}`),
    failed,
    checks: ctx.checks.length,
    durationMs: Math.round(performance.now() - t0),
    replay: replayCommand(seed, kind),
    evidence,
  };
}

Deno.test(
  `stress delete-confirm concurrency: ${
    STRESS_REPLAY.length ? `replay ${STRESS_REPLAY.join(",")}` : `${STRESS_ITER} seeded iterations`
  } (seed ${STRESS_SEED})`,
  async () => {
    const h = await loadDeleteConfirmWorld();
    const plan: Array<{ index: number; seed: number }> = STRESS_REPLAY.length
      ? STRESS_REPLAY.map((seed, index) => ({ index, seed }))
      : Array.from({ length: STRESS_ITER }, (_, index) => ({ index, seed: iterationSeed(index) }));
    const rows: IterationRow[] = [];
    const t0 = performance.now();
    for (const { index, seed } of plan) {
      rows.push(await runIteration(h, index, seed));
    }
    const broken = rows.filter((r) => r.outcome === "BROKEN");
    const report = {
      unit: "route-post-v1-me-delete-confirm",
      lens: "concurrency",
      campaignSeed: STRESS_SEED,
      latencyMaxMs: STRESS_LATENCY_MS,
      iterations: rows.length,
      checks: rows.reduce((n, r) => n + r.checks, 0),
      requests: rows.reduce((n, r) => n + r.statuses.length, 0),
      held: rows.length - broken.length,
      broken: broken.length,
      kinds: histogram(rows.map((r) => r.kind)),
      statusHistogram: histogram(
        rows.flatMap((r) => r.statuses.map((s) => s.split(":").slice(1).join(":"))),
      ),
      durationMs: Math.round(performance.now() - t0),
      heap: Deno.memoryUsage(),
      brokenSeeds: broken.map((r) => ({
        seed: r.seed,
        kind: r.kind,
        failed: r.failed,
        replay: r.replay,
      })),
      rows,
    };
    const dir = outDir();
    await Deno.mkdir(dir, { recursive: true });
    const path = `${dir}stress_delete_confirm_${STRESS_SEED}${
      STRESS_REPLAY.length ? "_replay" : ""
    }.json`;
    await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
    console.log(
      `[stress] delete-confirm: ${rows.length} iterations, ${report.requests} requests, ${report.checks} checks, held=${report.held} broken=${report.broken} in ${report.durationMs}ms → ${path}`,
    );
    for (const r of broken) {
      console.log(`[stress]   BROKEN seed=${r.seed} kind=${r.kind}`);
      for (const f of r.failed) console.log(`[stress]     ${f}`);
      console.log(`[stress]     replay: ${r.replay}`);
    }
    assert(rows.length > 0, "no iterations ran");
    assert(
      broken.length === 0,
      `${broken.length}/${rows.length} iterations BROKEN — see ${path}; first: seed=${
        broken[0]?.seed
      } ${broken[0]?.failed[0]}`,
    );
  },
);
