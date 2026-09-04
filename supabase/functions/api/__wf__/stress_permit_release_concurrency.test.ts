/**
 * stress: POST /v1/analysis-permits/:id/finalize (release) × POST /v1/shots:sync
 * (consume) — CONCURRENCY lens, real handler in-process.
 *
 *   deno test -A --no-check --config deno.json stress_permit_release_concurrency.test.ts
 *   STRESS_ITER=600 STRESS_OUT_DIR=/tmp/stress deno test -A --no-check --config deno.json \
 *     stress_permit_release_concurrency.test.ts            # the evidence campaign
 *   STRESS_SEED=<seed> STRESS_ITER=1 STRESS_SCENARIO=<name> …  # replay one iteration
 *   STRESS_REPEAT=10 …                                        # flake rate for a seed
 *
 * Each iteration: fresh seeded fake, fresh user(s) bootstrapped through the
 * real route, one Promise.all burst whose lane order / start offsets / upstream
 * latencies all come from the seed. Invariants are checked on the responses
 * AND on the modelled tables. The campaign report (seed → outcome JSON) lands
 * in STRESS_OUT_DIR (default artifacts/stress-permit-release/latest/).
 */
import { assert, assertEquals } from "@std/assert";
import {
  acceptedIds,
  access,
  actorFor,
  call,
  finalize,
  freeRatingsOf,
  type Call,
  type IterationContext,
  logout,
  permitOf,
  permitRow,
  refresh,
  rejectedCodes,
  RELEASABLE_OUTCOMES,
  reserve,
  runCampaign,
  summarize,
  type Scenario,
  STRESS_ITER,
  syncShot,
} from "./stress_permit_release_harness.ts";
import { edgeRequest, histogram, sleep } from "./xc_concurrency_harness.ts";

const FILE = "stress_permit_release_concurrency.test.ts";
const FINALIZED_CODE = "access.permit_already_finalized";

const pick = <T>(ctx: IterationContext, items: readonly T[]): T =>
  items[ctx.prng.int(0, items.length - 1)];

async function reservedActor(ctx: IterationContext, lane = 0) {
  const actor = await actorFor(ctx.h, ctx.sub(), ctx.ip(lane));
  const r = await reserve(ctx.h, ctx.calls, actor, `k-${ctx.seed}-${lane}`);
  const permit = permitOf(r);
  if (r.status !== 200 || !permit)
    throw new Error(`reserve failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { actor, permitId: String(permit.id) };
}

function patchedRows(ctx: IterationContext, who?: string): number {
  return ctx.h.fake.patchLog
    .filter((p) => who === undefined || p.who === who)
    .reduce((n, p) => n + p.matched, 0);
}

function userPermits(ctx: IterationContext, sub: string) {
  return ctx.h.fake.tables.analysis_permits.filter((p) => p.user_id === sub);
}

function scoredShots(ctx: IterationContext, sub: string) {
  return ctx.h.fake.tables.shots.filter((s) => s.user_id === sub && s.result_kind === "scored");
}

// ── Scenarios ────────────────────────────────────────────────────────────────

/** Duplicate release calls with ONE outcome: every copy must succeed and read
 * the same terminal row; exactly one UPDATE may match. */
const dupSameOutcome: Scenario = async (ctx) => {
  const { actor, permitId } = await reservedActor(ctx);
  const outcome = pick(ctx, RELEASABLE_OUTCOMES);
  const k = ctx.prng.int(4, 24);
  const results = await ctx.burst(
    Array.from({ length: k }, () => () => finalize(ctx.h, ctx.calls, actor, permitId, outcome)),
  );
  const row = permitRow(ctx.h, permitId);
  ctx.observations.k = k;
  ctx.observations.outcome = outcome;
  ctx.observations.statuses = histogram(results.map((r) => r.status));
  ctx.inv(
    "idempotent: every duplicate is HTTP 200",
    results.every((r) => r.status === 200),
    JSON.stringify(ctx.observations.statuses),
  );
  ctx.inv(
    "every response shows the same terminal permit",
    results.every((r) => permitOf(r)?.status === "finalized" && permitOf(r)?.outcome === outcome),
    JSON.stringify(results.map((r) => [permitOf(r)?.status, permitOf(r)?.outcome])),
  );
  ctx.inv(
    "row finalized with the requested outcome",
    row?.status === "finalized" && row?.outcome === outcome,
    `${row?.status}/${row?.outcome}`,
  );
  ctx.inv(
    "exactly one UPDATE matched a row (no lost update, no double write)",
    patchedRows(ctx) === 1,
    `matched=${patchedRows(ctx)}`,
  );
  ctx.inv(
    "no duplicate permit rows",
    userPermits(ctx, actor.sub).length === 1,
    `rows=${userPermits(ctx, actor.sub).length}`,
  );
  ctx.inv(
    "released permit no longer counts as reserved in any response",
    results.every(
      (r) =>
        freeRatingsOf(r)?.reserved === 0 &&
        freeRatingsOf(r)?.used === 0 &&
        freeRatingsOf(r)?.availableToReserve === 2,
    ),
    JSON.stringify(results.map((r) => freeRatingsOf(r))),
  );
};

/** Conflicting outcomes race for one permit: exactly one wins, every loser is
 * told 409 with the winner's outcome, and the winner never flips. */
const dupMixedOutcomes: Scenario = async (ctx) => {
  const { actor, permitId } = await reservedActor(ctx);
  const k = ctx.prng.int(3, 24);
  const outcomes = Array.from({ length: k }, () => pick(ctx, RELEASABLE_OUTCOMES));
  const results = await ctx.burst(
    outcomes.map((o) => () => finalize(ctx.h, ctx.calls, actor, permitId, o)),
  );
  const row = permitRow(ctx.h, permitId);
  const winner = String(row?.outcome);
  ctx.observations.k = k;
  ctx.observations.outcomes = histogram(outcomes);
  ctx.observations.winner = winner;
  ctx.observations.statuses = histogram(results.map((r) => r.status));
  ctx.inv(
    "row finalized with one of the requested outcomes",
    row?.status === "finalized" && outcomes.includes(winner as never),
    `${row?.status}/${winner}`,
  );
  ctx.inv(
    "statuses ⊆ {200, 409}",
    results.every((r) => r.status === 200 || r.status === 409),
    JSON.stringify(ctx.observations.statuses),
  );
  ctx.inv(
    "at least one caller succeeded",
    results.some((r) => r.status === 200),
  );
  ctx.inv(
    "200 ⇔ requested the winning outcome; 409 ⇔ requested another (code access.permit_already_finalized)",
    results.every((r, i) =>
      outcomes[i] === winner
        ? r.status === 200 && permitOf(r)?.outcome === winner
        : r.status === 409 && r.code === FINALIZED_CODE,
    ),
    JSON.stringify(results.map((r, i) => `${outcomes[i]}→${r.status}`)),
  );
  ctx.inv(
    "409 message names the winner (no stale/unknown outcome leaked)",
    results
      .filter((r) => r.status === 409)
      .every((r) =>
        String((r.body.error as { message?: string })?.message ?? "").includes(`as ${winner}.`),
      ),
    JSON.stringify(
      results
        .filter((r) => r.status === 409)
        .map((r) => (r.body.error as { message?: string })?.message),
    ),
  );
  ctx.inv(
    "exactly one UPDATE matched (no lost update)",
    patchedRows(ctx) === 1,
    `matched=${patchedRows(ctx)}`,
  );
  const winnerPatch = ctx.h.fake.patchLog.find((p) => p.matched === 1);
  ctx.inv(
    "the row holds the outcome of the ONE matching UPDATE",
    winnerPatch?.set.outcome === winner,
    `patch=${JSON.stringify(winnerPatch?.set)} row=${winner}`,
  );
};

/** Release racing consume: user cancels / analysis fails while the scored
 * shot is syncing. The permit ends in exactly ONE terminal state and the two
 * free ratings are never double-spent. */
const finalizeVsConsume: Scenario = async (ctx) => {
  const { actor, permitId } = await reservedActor(ctx);
  const f = ctx.prng.int(1, 8);
  const s = ctx.prng.int(1, 8);
  const sameShot = ctx.prng.int(0, 1) === 1;
  const shotIds = Array.from({ length: s }, () => ctx.prng.uuid());
  const shotId = shotIds[0];
  const abstain = ctx.prng.int(0, 4) === 0; // 20 %: the sync itself is an abstention
  const kind = abstain ? "low_confidence" : "scored";
  const overrides = abstain ? { resultKind: "low_confidence", overallScore: null } : {};
  const outcomes = Array.from({ length: f }, () => pick(ctx, RELEASABLE_OUTCOMES));
  const tasks = [
    ...outcomes.map((o) => () => finalize(ctx.h, ctx.calls, actor, permitId, o)),
    ...shotIds.map(
      (id) => () => syncShot(ctx.h, ctx.calls, actor, sameShot ? shotId : id, permitId, overrides),
    ),
  ];
  const results = await ctx.burst(tasks);
  const fin = results.slice(0, f);
  const syncs = results.slice(f);
  const row = permitRow(ctx.h, permitId);
  const shotRows = ctx.h.fake.tables.shots.filter((x) => x.analysis_permit_id === permitId);
  const scored = scoredShots(ctx, actor.sub).length;
  const consumed = shotRows.length > 0;
  ctx.observations.lanes = { finalize: f, sync: s, sameShot, kind, outcomes: histogram(outcomes) };
  ctx.observations.finalizeStatuses = histogram(fin.map((r) => r.status));
  ctx.observations.syncVerdicts = histogram(
    syncs.flatMap((r) => (acceptedIds(r).length ? ["accepted"] : rejectedCodes(r))),
  );
  ctx.observations.terminal = `${row?.status}/${row?.outcome}`;
  ctx.observations.consumed = consumed;
  ctx.inv(
    "at most one shot row consumed the permit (no duplicate rows)",
    shotRows.length <= 1,
    `rows=${shotRows.length}`,
  );
  ctx.inv("permit left reserved by nobody", row?.status !== "reserved", String(row?.status));
  ctx.inv(
    "scored ratings spent ≤ 1 for one permit (no double spend)",
    scored <= 1 && scored === (consumed && kind === "scored" ? 1 : 0),
    `scored=${scored}`,
  );
  ctx.inv(
    "every sync is HTTP 200 (verdicts ride in the body)",
    syncs.every((r) => r.status === 200),
    JSON.stringify(histogram(syncs.map((r) => r.status))),
  );
  ctx.inv(
    "finalize statuses ⊆ {200, 409}",
    fin.every((r) => r.status === 200 || r.status === 409),
    JSON.stringify(ctx.observations.finalizeStatuses),
  );
  if (consumed) {
    const expected = kind === "scored" ? ["finalized", "scored"] : ["released", "low_confidence"];
    ctx.inv(
      "consume won: permit reflects the shot",
      row?.status === expected[0] && row?.outcome === expected[1],
      `${row?.status}/${row?.outcome}`,
    );
    ctx.inv(
      "consume won: every release call is 409 unless it asked for the same outcome",
      fin.every((r, i) =>
        outcomes[i] === row?.outcome
          ? r.status === 200
          : r.status === 409 && r.code === FINALIZED_CODE,
      ),
      JSON.stringify(fin.map((r, i) => `${outcomes[i]}→${r.status}`)),
    );
    ctx.inv(
      "consume won: no release UPDATE matched",
      patchedRows(ctx) === 0,
      `matched=${patchedRows(ctx)}`,
    );
    if (sameShot) {
      ctx.inv(
        "same shot id: every copy accepted (idempotent replay)",
        syncs.every((r) => acceptedIds(r).includes(shotId)),
        JSON.stringify(ctx.observations.syncVerdicts),
      );
    } else {
      const accepted = syncs.filter((r) => acceptedIds(r).length > 0).length;
      const losers = syncs.filter((r) => acceptedIds(r).length === 0).flatMap(rejectedCodes);
      ctx.inv(
        "distinct shots: exactly one accepted, others access.permit_not_reserved",
        accepted === 1 && losers.every((c) => c === "access.permit_not_reserved"),
        JSON.stringify(ctx.observations.syncVerdicts),
      );
    }
  } else {
    ctx.inv(
      "release won: permit finalized with a requested outcome",
      row?.status === "finalized" && outcomes.includes(String(row?.outcome) as never),
      `${row?.status}/${row?.outcome}`,
    );
    ctx.inv(
      "release won: exactly one UPDATE matched",
      patchedRows(ctx) === 1,
      `matched=${patchedRows(ctx)}`,
    );
    ctx.inv(
      "release won: every sync rejected access.permit_not_reserved (retryable to the outbox, never a permanent verdict)",
      syncs.every(
        (r) =>
          acceptedIds(r).length === 0 &&
          rejectedCodes(r).every((c) => c === "access.permit_not_reserved"),
      ),
      JSON.stringify(ctx.observations.syncVerdicts),
    );
  }
  const after = await access(ctx.h, ctx.calls, actor);
  const fr = freeRatingsOf(after);
  ctx.inv(
    "access after the race: used = scored shots, reserved = 0",
    fr?.used === scored && fr?.reserved === 0 && fr?.remaining === 2 - scored,
    JSON.stringify(fr),
  );
};

/** Two actors on one row: a second signed-in user hammers A's permit id. */
const twoActors: Scenario = async (ctx) => {
  const { actor: a, permitId } = await reservedActor(ctx, 0);
  const b = await actorFor(ctx.h, ctx.sub(), ctx.ip(1));
  const k = ctx.prng.int(3, 16);
  const aCalls = ctx.prng.int(0, 2);
  const aOutcome = pick(ctx, RELEASABLE_OUTCOMES);
  const bShot = ctx.prng.uuid();
  const tasks = [
    ...Array.from(
      { length: k },
      () => () =>
        finalize(ctx.h, ctx.calls, b, permitId, pick(ctx, RELEASABLE_OUTCOMES), "finalize.B"),
    ),
    () => syncShot(ctx.h, ctx.calls, b, bShot, permitId, {}, "sync.B"),
    ...Array.from(
      { length: aCalls },
      () => () => finalize(ctx.h, ctx.calls, a, permitId, aOutcome, "finalize.A"),
    ),
  ];
  const results = await ctx.burst(tasks);
  const bFin = results.slice(0, k);
  const bSync = results[k];
  const aFin = results.slice(k + 1);
  const row = permitRow(ctx.h, permitId);
  ctx.observations.k = k;
  ctx.observations.aCalls = aCalls;
  ctx.observations.bStatuses = histogram(bFin.map((r) => r.status));
  ctx.inv(
    "B's release calls are all 404 access.permit_not_found",
    bFin.every((r) => r.status === 404 && r.code === "access.permit_not_found"),
    JSON.stringify(ctx.observations.bStatuses),
  );
  ctx.inv(
    "B's consume attempt is rejected access.permit_not_found",
    bSync.status === 200 &&
      acceptedIds(bSync).length === 0 &&
      rejectedCodes(bSync)[0] === "access.permit_not_found",
    JSON.stringify(bSync.body),
  );
  ctx.inv(
    "B never matched an UPDATE",
    patchedRows(ctx, b.sub) === 0,
    `matched=${patchedRows(ctx, b.sub)}`,
  );
  ctx.inv("row still belongs to A", row?.user_id === a.sub);
  ctx.inv(
    "no shot row for B",
    ctx.h.fake.tables.shots.every((s) => s.user_id !== b.sub),
  );
  if (aCalls === 0) {
    ctx.inv(
      "A did not call: row untouched (still reserved)",
      row?.status === "reserved" && row?.outcome === null,
      `${row?.status}/${row?.outcome}`,
    );
  } else {
    ctx.inv(
      "A's own release succeeded",
      aFin.every((r) => r.status === 200) &&
        row?.status === "finalized" &&
        row?.outcome === aOutcome,
      JSON.stringify(aFin.map((r) => r.status)),
    );
  }
  const bAccess = await access(ctx.h, ctx.calls, b, "access.B");
  ctx.inv(
    "B's own access is untouched by A's permit",
    bAccess.status === 200 &&
      freeRatingsOf(bAccess)?.reserved === 0 &&
      freeRatingsOf(bAccess)?.used === 0,
    JSON.stringify(freeRatingsOf(bAccess)),
  );
};

/** Logout lands inside the burst: every lane is 200 (raced ahead) or 401
 * (fenced); the row is never half-written; the fenced token stays dead. */
const logoutDuring: Scenario = async (ctx) => {
  const { actor, permitId } = await reservedActor(ctx);
  const outcome = pick(ctx, RELEASABLE_OUTCOMES);
  const k = ctx.prng.int(3, 16);
  const tasks: Array<() => Promise<unknown>> = Array.from(
    { length: k },
    () => () => finalize(ctx.h, ctx.calls, actor, permitId, outcome),
  );
  tasks.splice(ctx.prng.int(0, k), 0, () => logout(ctx.h, ctx.calls, actor));
  await ctx.burst(tasks);
  const fin = ctx.calls.filter((c) => c.op === "finalize");
  const lo = ctx.calls.find((c) => c.op === "logout");
  const row = permitRow(ctx.h, permitId);
  ctx.observations.k = k;
  ctx.observations.statuses = histogram(fin.map((r) => r.status));
  ctx.inv("logout is 204", lo?.status === 204, String(lo?.status));
  ctx.inv(
    "finalize statuses ⊆ {200, 401}",
    fin.every((r) => r.status === 200 || r.status === 401),
    JSON.stringify(ctx.observations.statuses),
  );
  ctx.inv(
    "row finalized ⇔ some lane got 200",
    (row?.status === "finalized") === fin.some((r) => r.status === 200),
    `${row?.status} ${JSON.stringify(ctx.observations.statuses)}`,
  );
  ctx.inv(
    "row is either untouched or finalized with the outcome",
    (row?.status === "reserved" && row?.outcome === null) ||
      (row?.status === "finalized" && row?.outcome === outcome),
    `${row?.status}/${row?.outcome}`,
  );
  const late = await finalize(ctx.h, ctx.calls, actor, permitId, outcome, "finalize.afterLogout");
  ctx.inv(
    "the logged-out bearer is refused afterwards (401)",
    late.status === 401,
    String(late.status),
  );
  const again = await actorFor(ctx.h, actor.sub, actor.ip);
  const recover = await finalize(ctx.h, ctx.calls, again, permitId, outcome, "finalize.newSession");
  const rowAfter = permitRow(ctx.h, permitId);
  ctx.inv(
    "a fresh session settles the permit (200) and it is finalized",
    recover.status === 200 && rowAfter?.status === "finalized" && rowAfter?.outcome === outcome,
    `${recover.status} ${rowAfter?.status}/${rowAfter?.outcome}`,
  );
  ctx.inv(
    "exactly one UPDATE matched overall",
    patchedRows(ctx) === 1,
    `matched=${patchedRows(ctx)}`,
  );
};

/** Refresh (token rotation) lands inside the burst: the old access token is
 * still a valid session bearer, so every lane succeeds; the rotated token
 * sees the same terminal row. */
const rotationDuring: Scenario = async (ctx) => {
  const { actor, permitId } = await reservedActor(ctx);
  const outcome = pick(ctx, RELEASABLE_OUTCOMES);
  const k = ctx.prng.int(3, 16);
  const tasks: Array<() => Promise<unknown>> = Array.from(
    { length: k },
    () => () => finalize(ctx.h, ctx.calls, actor, permitId, outcome),
  );
  tasks.splice(ctx.prng.int(0, k), 0, () => refresh(ctx.h, ctx.calls, actor));
  await ctx.burst(tasks);
  const fin = ctx.calls.filter((c) => c.op === "finalize");
  const rot = ctx.calls.find((c) => c.op === "refresh");
  const session =
    rot && typeof rot.body.session === "object"
      ? (rot.body.session as Record<string, unknown>)
      : null;
  ctx.observations.k = k;
  ctx.observations.statuses = histogram(fin.map((r) => r.status));
  ctx.inv(
    "refresh is 200 with a new access token",
    rot?.status === 200 &&
      typeof session?.accessToken === "string" &&
      session.accessToken !== actor.accessToken,
    String(rot?.status),
  );
  ctx.inv(
    "every finalize with the pre-rotation bearer is 200",
    fin.every((r) => r.status === 200),
    JSON.stringify(ctx.observations.statuses),
  );
  if (session && typeof session.accessToken === "string") {
    const withNew = await finalize(
      ctx.h,
      ctx.calls,
      actor,
      permitId,
      outcome,
      "finalize.rotated",
      session.accessToken,
    );
    ctx.inv(
      "the rotated bearer sees the same terminal permit (200, idempotent)",
      withNew.status === 200 && permitOf(withNew)?.outcome === outcome,
      `${withNew.status} ${JSON.stringify(permitOf(withNew))}`,
    );
  }
  ctx.inv("exactly one UPDATE matched", patchedRows(ctx) === 1, `matched=${patchedRows(ctx)}`);
};

/** Client-side cancel: the app abandons its first request (never awaits it)
 * and immediately storms retries. The abandoned request still lands. */
const cancelThenRetry: Scenario = async (ctx) => {
  const { actor, permitId } = await reservedActor(ctx);
  const first = pick(ctx, RELEASABLE_OUTCOMES);
  const retryOutcome = ctx.prng.int(0, 2) === 0 ? pick(ctx, RELEASABLE_OUTCOMES) : first;
  const abandoned = finalize(ctx.h, ctx.calls, actor, permitId, first, "finalize.abandoned");
  await sleep(ctx.prng.int(0, 6));
  const k = ctx.prng.int(2, 12);
  const retries = await ctx.burst(
    Array.from(
      { length: k },
      () => () => finalize(ctx.h, ctx.calls, actor, permitId, retryOutcome, "finalize.retry"),
    ),
  );
  const orphan = await abandoned;
  const row = permitRow(ctx.h, permitId);
  const winner = String(row?.outcome);
  ctx.observations.first = first;
  ctx.observations.retryOutcome = retryOutcome;
  ctx.observations.winner = winner;
  ctx.observations.statuses = histogram([orphan, ...retries].map((r) => r.status));
  ctx.inv(
    "the abandoned request completed (nothing hangs)",
    orphan.status === 200 || orphan.status === 409,
    String(orphan.status),
  );
  ctx.inv(
    "row finalized as first or retry outcome",
    row?.status === "finalized" && (winner === first || winner === retryOutcome),
    `${row?.status}/${winner}`,
  );
  ctx.inv("abandoned: 200 ⇔ its outcome won", orphan.status === (first === winner ? 200 : 409));
  ctx.inv(
    "retries: 200 ⇔ their outcome won, else 409",
    retries.every((r) => r.status === (retryOutcome === winner ? 200 : 409)),
    JSON.stringify(ctx.observations.statuses),
  );
  ctx.inv("exactly one UPDATE matched", patchedRows(ctx) === 1, `matched=${patchedRows(ctx)}`);
};

/** Clock skew / stale hold: the permit is older than its 24 h lifetime but
 * the hourly sweep has not run yet; the sweep then fires mid-burst. The row
 * must settle exactly once and access must never count the stale hold. */
const expiredSkewSweep: Scenario = async (ctx) => {
  const { actor, permitId } = await reservedActor(ctx);
  ctx.h.fake.agePermit(permitId, 24 * 3_600_000 + ctx.prng.int(1, 3_600_000));
  const k = ctx.prng.int(2, 12);
  const outcomes = Array.from({ length: k }, () => pick(ctx, RELEASABLE_OUTCOMES));
  const withSync = ctx.prng.int(0, 1) === 1;
  const shotId = ctx.prng.uuid();
  const sweepDelay = ctx.prng.int(0, 12);
  const tasks: Array<() => Promise<Call | null>> = outcomes.map(
    (o) => () => finalize(ctx.h, ctx.calls, actor, permitId, o),
  );
  if (withSync) tasks.push(() => syncShot(ctx.h, ctx.calls, actor, shotId, permitId));
  tasks.push(async () => {
    await sleep(sweepDelay);
    ctx.h.fake.sweepExpired();
    return null;
  });
  const results = await ctx.burst(tasks);
  const fin = results.slice(0, k) as Call[];
  const sync = withSync ? (results[k] as Call) : null;
  const row = permitRow(ctx.h, permitId);
  const terminal = `${row?.status}/${row?.outcome}`;
  ctx.observations.k = k;
  ctx.observations.withSync = withSync;
  ctx.observations.terminal = terminal;
  ctx.observations.statuses = histogram(fin.map((r) => r.status));
  ctx.observations.syncVerdict = sync
    ? acceptedIds(sync).length
      ? "accepted"
      : rejectedCodes(sync)
    : null;
  ctx.inv(
    "permit settled exactly one way: finalized/<requested> or released/expired",
    (row?.status === "finalized" && outcomes.includes(String(row?.outcome) as never)) ||
      (row?.status === "released" && row?.outcome === "expired"),
    terminal,
  );
  ctx.inv(
    "finalize statuses ⊆ {200, 409}",
    fin.every((r) => r.status === 200 || r.status === 409),
    JSON.stringify(ctx.observations.statuses),
  );
  ctx.inv(
    "200 ⇔ requested the terminal outcome",
    fin.every((r, i) =>
      outcomes[i] === row?.outcome
        ? r.status === 200
        : r.status === 409 && r.code === FINALIZED_CODE,
    ),
    JSON.stringify(fin.map((r, i) => `${outcomes[i]}→${r.status}`)),
  );
  ctx.inv(
    "an expired permit is never consumed by a scored shot",
    !sync || acceptedIds(sync).length === 0,
    JSON.stringify(ctx.observations.syncVerdict),
  );
  ctx.inv("no scored shot exists", scoredShots(ctx, actor.sub).length === 0);
  ctx.inv("UPDATE matched at most once", patchedRows(ctx) <= 1, `matched=${patchedRows(ctx)}`);
  ctx.inv(
    "every 200 reports reserved=0 (stale hold not counted)",
    fin.filter((r) => r.status === 200).every((r) => freeRatingsOf(r)?.reserved === 0),
    JSON.stringify(fin.map((r) => freeRatingsOf(r)?.reserved)),
  );
};

/** Reserve/release churn on a free account: lanes reserve distinct keys and
 * some release immediately; no more than two permits may ever be live. */
const reserveReleaseCycle: Scenario = async (ctx) => {
  const actor = await actorFor(ctx.h, ctx.sub(), ctx.ip(0));
  const n = ctx.prng.int(3, 10);
  const lanes = Array.from({ length: n }, (_, i) => ({
    key: `c-${ctx.seed}-${i}`,
    release: ctx.prng.int(0, 2) > 0,
    outcome: pick(ctx, RELEASABLE_OUTCOMES),
  }));
  const results = await ctx.burst(
    lanes.map((lane) => async () => {
      const r = await reserve(ctx.h, ctx.calls, actor, lane.key);
      const permit = permitOf(r);
      if (r.status !== 200 || !permit || !lane.release) return { reserve: r, finalize: null };
      await sleep(ctx.prng.int(0, 4));
      return {
        reserve: r,
        finalize: await finalize(ctx.h, ctx.calls, actor, String(permit.id), lane.outcome),
      };
    }),
  );
  const accepted = results.filter((r) => r.reserve.status === 200);
  const rows = userPermits(ctx, actor.sub);
  const live = ctx.h.fake.liveReserved(actor.sub);
  const maxLive = ctx.h.fake.maxLiveReserved.get(actor.sub) ?? 0;
  ctx.observations.n = n;
  ctx.observations.accepted = accepted.length;
  ctx.observations.maxLive = maxLive;
  ctx.observations.reserveStatuses = histogram(
    results.map((r) => `${r.reserve.status}:${r.reserve.code ?? "ok"}`),
  );
  ctx.inv(
    "never more than 2 permits live at once (free ratings not over-issued)",
    maxLive <= 2,
    `maxLive=${maxLive}`,
  );
  ctx.inv(
    "reserve statuses ⊆ {200, 402/paywall}",
    results.every((r) => r.reserve.status === 200 || r.reserve.code === "access.paywall_required"),
    JSON.stringify(ctx.observations.reserveStatuses),
  );
  ctx.inv(
    "no duplicate rows per idempotency key",
    new Set(rows.map((r) => r.idempotency_key)).size === rows.length &&
      rows.length === accepted.length,
    `rows=${rows.length} accepted=${accepted.length}`,
  );
  ctx.inv(
    "every accepted permit id is unique",
    new Set(accepted.map((r) => permitOf(r.reserve)?.id)).size === accepted.length,
  );
  ctx.inv(
    "every release of an accepted permit is 200",
    results.every((r) => r.finalize === null || r.finalize.status === 200),
    JSON.stringify(histogram(results.map((r) => r.finalize?.status ?? "-"))),
  );
  ctx.inv(
    "released permits are finalized with their outcome, held ones stay reserved",
    results.every((r, i) => {
      if (r.reserve.status !== 200) return true;
      const row = permitRow(ctx.h, String(permitOf(r.reserve)?.id));
      return r.finalize
        ? row?.status === "finalized" && row?.outcome === lanes[i].outcome
        : row?.status === "reserved";
    }),
    JSON.stringify(rows.map((r) => `${r.idempotency_key}:${r.status}/${r.outcome}`)),
  );
  const after = await access(ctx.h, ctx.calls, actor);
  const fr = freeRatingsOf(after);
  ctx.inv(
    "access.reserved equals live reserved rows",
    fr?.reserved === live && fr?.availableToReserve === 2 - live,
    `${JSON.stringify(fr)} live=${live}`,
  );
};

/** Replaying the reservation key of a RELEASED permit must return that same
 * (finalized) permit — never mint a fresh one — while new keys may reuse the
 * freed slot. */
const replayReserveAfterRelease: Scenario = async (ctx) => {
  const { actor, permitId } = await reservedActor(ctx);
  const outcome = pick(ctx, RELEASABLE_OUTCOMES);
  const rel = await finalize(ctx.h, ctx.calls, actor, permitId, outcome);
  ctx.inv("precondition: release 200", rel.status === 200, String(rel.status));
  const replays = ctx.prng.int(2, 10);
  const fresh = ctx.prng.int(1, 4);
  const results = await ctx.burst([
    ...Array.from(
      { length: replays },
      () => () => reserve(ctx.h, ctx.calls, actor, `k-${ctx.seed}-0`, "reserve.replay"),
    ),
    ...Array.from(
      { length: fresh },
      (_, i) => () => reserve(ctx.h, ctx.calls, actor, `k-${ctx.seed}-new-${i}`, "reserve.fresh"),
    ),
  ]);
  const rep = results.slice(0, replays);
  const nw = results.slice(replays);
  const rows = userPermits(ctx, actor.sub);
  ctx.observations.replays = replays;
  ctx.observations.fresh = fresh;
  ctx.observations.replayStatuses = histogram(
    rep.map((r) => `${r.status}:${permitOf(r)?.status ?? r.code}`),
  );
  ctx.observations.freshStatuses = histogram(nw.map((r) => `${r.status}:${r.code ?? "ok"}`));
  ctx.inv(
    "every replay returns the SAME permit id, finalized with the outcome",
    rep.every(
      (r) =>
        r.status === 200 &&
        permitOf(r)?.id === permitId &&
        permitOf(r)?.status === "finalized" &&
        permitOf(r)?.outcome === outcome,
    ),
    JSON.stringify(ctx.observations.replayStatuses),
  );
  ctx.inv(
    "fresh keys: accepted ≤ 2 live, rest paywall",
    nw.every((r) => r.status === 200 || r.code === "access.paywall_required") &&
      ctx.h.fake.liveReserved(actor.sub) <= 2,
    JSON.stringify(ctx.observations.freshStatuses),
  );
  ctx.inv(
    "rows = 1 released + accepted fresh (no duplicates)",
    rows.length === 1 + nw.filter((r) => r.status === 200).length,
    `rows=${rows.length}`,
  );
  ctx.inv("max live reserved ≤ 2", (ctx.h.fake.maxLiveReserved.get(actor.sub) ?? 0) <= 2);
};

/** Premium member: unlimited reserves, releases and consumes in one burst. */
const premiumCycle: Scenario = async (ctx) => {
  const actor = await actorFor(ctx.h, ctx.sub(), ctx.ip(0));
  ctx.h.fake.grantPremium(actor.sub);
  const n = ctx.prng.int(3, 8);
  const lanes = Array.from({ length: n }, (_, i) => ({
    key: `p-${ctx.seed}-${i}`,
    mode: (["release", "consume", "both", "hold"] as const)[ctx.prng.int(0, 3)],
    outcome: pick(ctx, RELEASABLE_OUTCOMES),
    shot: ctx.prng.uuid(),
  }));
  const results = await ctx.burst(
    lanes.map((lane) => async () => {
      const r = await reserve(ctx.h, ctx.calls, actor, lane.key);
      const permit = permitOf(r);
      if (r.status !== 200 || !permit)
        return { reserve: r, ops: [] as Array<{ op: string; status: number; ok: boolean }> };
      const id = String(permit.id);
      const ops: Array<() => Promise<{ op: string; status: number; ok: boolean }>> = [];
      if (lane.mode === "release" || lane.mode === "both") {
        ops.push(async () => {
          const f = await finalize(ctx.h, ctx.calls, actor, id, lane.outcome);
          return { op: "finalize", status: f.status, ok: f.status === 200 };
        });
      }
      if (lane.mode === "consume" || lane.mode === "both") {
        ops.push(async () => {
          const s = await syncShot(ctx.h, ctx.calls, actor, lane.shot, id);
          return { op: "sync", status: s.status, ok: acceptedIds(s).includes(lane.shot) };
        });
      }
      return { reserve: r, ops: await Promise.all(ops.map((fn) => fn())) };
    }),
  );
  const rows = userPermits(ctx, actor.sub);
  const scored = scoredShots(ctx, actor.sub).length;
  ctx.observations.n = n;
  ctx.observations.modes = histogram(lanes.map((l) => l.mode));
  ctx.observations.reserveStatuses = histogram(results.map((r) => r.reserve.status));
  ctx.inv(
    "premium: every reserve accepted",
    results.every((r) => r.reserve.status === 200),
    JSON.stringify(ctx.observations.reserveStatuses),
  );
  ctx.inv(
    "premium: never paywalled",
    ctx.calls.every(
      (c) =>
        c.code !== "access.paywall_required" &&
        !rejectedCodes(c).includes("access.paywall_required"),
    ),
  );
  ctx.inv(
    "one row per key",
    rows.length === n && new Set(rows.map((r) => r.idempotency_key)).size === n,
    `rows=${rows.length}`,
  );
  ctx.inv(
    "per lane: release-only → finalized/outcome; consume-only → finalized/scored; both → exactly one of them won; hold → reserved",
    lanes.every((lane, i) => {
      const row = rows.find((r) => r.idempotency_key === lane.key);
      const ops = results[i].ops;
      if (lane.mode === "hold") return row?.status === "reserved";
      if (lane.mode === "release")
        return row?.status === "finalized" && row?.outcome === lane.outcome && ops[0]?.ok;
      if (lane.mode === "consume")
        return row?.status === "finalized" && row?.outcome === "scored" && ops[0]?.ok;
      const wins = ops.filter((o) => o.ok).length;
      return (
        wins === 1 &&
        row?.status === "finalized" &&
        (row?.outcome === lane.outcome || row?.outcome === "scored")
      );
    }),
    JSON.stringify(
      lanes.map(
        (l, i) =>
          `${l.mode}:${rows.find((r) => r.idempotency_key === l.key)?.outcome}:${results[i].ops.map((o) => o.status)}`,
      ),
    ),
  );
  ctx.inv(
    "scored shots = permits consumed as scored",
    scored === rows.filter((r) => r.outcome === "scored").length,
    `scored=${scored}`,
  );
  const after = await access(ctx.h, ctx.calls, actor);
  ctx.inv(
    "access: premium, canStartRating",
    after.status === 200 && after.body.premium === true && after.body.canStartRating === true,
    JSON.stringify(after.body),
  );
};

/** Free-limit backstop: two ratings already spent, then permits over-issued
 * while premium lapsed. Consume must be refused by the RPC's lifetime check,
 * release must still work, and the count never passes 2. */
const thirdRatingBackstop: Scenario = async (ctx) => {
  const actor = await actorFor(ctx.h, ctx.sub(), ctx.ip(0));
  for (let i = 0; i < 2; i++) {
    const r = await reserve(ctx.h, ctx.calls, actor, `spent-${ctx.seed}-${i}`, "reserve.spend");
    const s = await syncShot(
      ctx.h,
      ctx.calls,
      actor,
      ctx.prng.uuid(),
      String(permitOf(r)?.id),
      {},
      "sync.spend",
    );
    ctx.inv(
      `precondition: rating ${i + 1} spent`,
      r.status === 200 && acceptedIds(s).length === 1,
      `${r.status} ${JSON.stringify(s.body)}`,
    );
  }
  ctx.h.fake.grantPremium(actor.sub);
  const n = ctx.prng.int(2, 6);
  const permits: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await reserve(ctx.h, ctx.calls, actor, `over-${ctx.seed}-${i}`, "reserve.premium");
    if (r.status === 200) permits.push(String(permitOf(r)?.id));
  }
  ctx.inv(
    "precondition: premium over-issued permits",
    permits.length === n,
    `${permits.length}/${n}`,
  );
  ctx.h.fake.tables.billing_entitlements = ctx.h.fake.tables.billing_entitlements.filter(
    (b) => b.user_id !== actor.sub,
  );
  const results = await ctx.burst(
    permits.flatMap((id) => [
      () => syncShot(ctx.h, ctx.calls, actor, ctx.prng.uuid(), id, {}, "sync.third"),
      () => finalize(ctx.h, ctx.calls, actor, id, pick(ctx, RELEASABLE_OUTCOMES), "finalize.third"),
    ]),
  );
  const syncs = results.filter((r) => r.op === "sync.third");
  const fin = results.filter((r) => r.op === "finalize.third");
  const scored = scoredShots(ctx, actor.sub).length;
  ctx.observations.n = n;
  ctx.observations.syncVerdicts = histogram(
    syncs.flatMap((r) => (acceptedIds(r).length ? ["accepted"] : rejectedCodes(r))),
  );
  ctx.observations.finalizeStatuses = histogram(fin.map((r) => r.status));
  ctx.inv(
    "lifetime scored count stays at 2 (no third free rating)",
    scored === 2,
    `scored=${scored}`,
  );
  ctx.inv(
    "no over-issued permit was consumed",
    syncs.every(
      (r) =>
        acceptedIds(r).length === 0 &&
        rejectedCodes(r).every(
          (c) => c === "access.paywall_required" || c === "access.permit_not_reserved",
        ),
    ),
    JSON.stringify(ctx.observations.syncVerdicts),
  );
  ctx.inv(
    "release lanes: 200 or 409 (lost to the backstop's release)",
    fin.every((r) => r.status === 200 || (r.status === 409 && r.code === FINALIZED_CODE)),
    JSON.stringify(ctx.observations.finalizeStatuses),
  );
  ctx.inv(
    "every over-issued permit is terminal",
    permits.every((id) => permitRow(ctx.h, id)?.status !== "reserved"),
    JSON.stringify(permits.map((id) => permitRow(ctx.h, id)?.status)),
  );
  const after = await access(ctx.h, ctx.calls, actor);
  const fr = freeRatingsOf(after);
  ctx.inv(
    "access: used=2, remaining=0, paywallRequired",
    fr?.used === 2 && fr?.remaining === 0 && after.body.paywallRequired === true,
    JSON.stringify(after.body),
  );
};

/** Malformed lanes (scored outcome, non-null ratingId, non-UUID id, missing
 * body) race valid releases: they must all be 400 and never touch the row. */
const invalidLanes: Scenario = async (ctx) => {
  const { actor, permitId } = await reservedActor(ctx);
  const outcome = pick(ctx, RELEASABLE_OUTCOMES);
  const k = ctx.prng.int(2, 8);
  const bad: Array<() => Promise<unknown>> = [
    () => finalize(ctx.h, ctx.calls, actor, permitId, "scored", "finalize.bad.scored"),
    () => finalize(ctx.h, ctx.calls, actor, permitId, "expired", "finalize.bad.expired"),
    () => finalize(ctx.h, ctx.calls, actor, "not-a-uuid", outcome, "finalize.bad.id"),
    () =>
      call(
        ctx.h,
        ctx.calls,
        "finalize.bad.ratingId",
        edgeRequest("POST", `/v1/analysis-permits/${permitId}/finalize`, {
          token: actor.accessToken,
          ip: actor.ip,
          body: { outcome, ratingId: "rating-1" },
        }),
      ),
    () =>
      call(
        ctx.h,
        ctx.calls,
        "finalize.bad.noBody",
        edgeRequest("POST", `/v1/analysis-permits/${permitId}/finalize`, {
          token: actor.accessToken,
          ip: actor.ip,
        }),
      ),
  ];
  await ctx.burst([
    ...Array.from({ length: k }, () => () => finalize(ctx.h, ctx.calls, actor, permitId, outcome)),
    ...bad,
  ]);
  const good = ctx.calls.filter((c) => c.op === "finalize");
  const badCalls = ctx.calls.filter((c) => c.op.startsWith("finalize.bad"));
  const row = permitRow(ctx.h, permitId);
  ctx.observations.badStatuses = histogram(badCalls.map((c) => `${c.op}:${c.status}:${c.code}`));
  ctx.inv(
    "every malformed lane is 400 validation.analysis_permit_finalize",
    badCalls.length === 5 &&
      badCalls.every((c) => c.status === 400 && c.code === "validation.analysis_permit_finalize"),
    JSON.stringify(ctx.observations.badStatuses),
  );
  ctx.inv(
    "every valid lane is 200",
    good.every((c) => c.status === 200),
    JSON.stringify(histogram(good.map((c) => c.status))),
  );
  ctx.inv(
    "row finalized with the valid outcome; exactly one UPDATE",
    row?.status === "finalized" && row?.outcome === outcome && patchedRows(ctx) === 1,
    `${row?.status}/${row?.outcome} matched=${patchedRows(ctx)}`,
  );
};

export const SCENARIOS: Record<string, Scenario> = {
  dup_same_outcome: dupSameOutcome,
  dup_mixed_outcomes: dupMixedOutcomes,
  finalize_vs_consume: finalizeVsConsume,
  two_actors_same_row: twoActors,
  logout_during_burst: logoutDuring,
  rotation_during_burst: rotationDuring,
  cancel_then_retry_storm: cancelThenRetry,
  expired_skew_sweep_race: expiredSkewSweep,
  reserve_release_cycle: reserveReleaseCycle,
  replay_reserve_after_release: replayReserveAfterRelease,
  premium_cycle: premiumCycle,
  third_rating_backstop: thirdRatingBackstop,
  invalid_lanes_never_mutate: invalidLanes,
};

Deno.test(
  `stress permit release/consume concurrency campaign (${STRESS_ITER} seeded iterations)`,
  async () => {
    const report = await runCampaign("permit_release_concurrency", FILE, SCENARIOS);
    console.error(summarize(report));
    assert(report.executed > 0, "no iterations executed");
    for (const f of report.failedSeeds) {
      console.error(
        `[stress] FAILED seed=${f.seed} scenario=${f.scenario}\n  ${f.failed.join("\n  ")}\n  replay: ${f.replay}`,
      );
    }
    assertEquals(
      report.failedSeeds.map((f) => `${f.scenario}#${f.seed}`),
      [],
      `${report.failed} failing iteration(s); see report`,
    );
  },
);
