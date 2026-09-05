// Concurrency stress campaign for GET /v1/progress — REAL handler in-process,
// Supabase/RevenueCat stubbed (stress_progress_harness.ts). Driven by
// stress_progress_concurrency.test.ts (Redis OFF: per-isolate L1 path) and
// stress_progress_redis.test.ts (fake Upstash L2 with fault injection); each
// test file runs in its own isolate, so cache.ts reads its own UPSTASH_* env.
//
// Every iteration is one seeded interleaving of one scenario family:
//
//   burst-cold         N duplicate GETs on a cold key (some cancel/abort);
//                      single-flight, identical bodies, bounded wall time.
//   read-write-race    GETs racing accepted shot syncs (new / low-confidence /
//                      replay / duplicate delivery) on one user; every body
//                      must equal the oracle for SOME committed set between
//                      "committed before the GET started" and "started before
//                      the GET ended" (read-your-writes + no torn/stale cache).
//   multi-user         read-write-race across 2-4 interleaved users (no
//                      cross-user leakage through cache/coalescing).
//   invalidation-gate  a build parked on its DB read while a sync lands; the
//                      GET issued after the sync must not coalesce onto the
//                      stale build and the stale payload must never be cached.
//   logout-rotation    logout or refresh rotation in the middle of a GET burst.
//   clock-skew         the server clock jumps mid-burst (cache TTL / auth
//                      cache / bearer expiry / streak "today").
//   db-fault           the view reads fail randomly; 503 only when a read
//                      failed, never cached, 200 bodies always correct.
//   paging-torn        a user with > 1000 series rows (readAllRows pages);
//                      a sync lands between page 1 and page 2 of a build.
//                      The stitched body must still be an admissible
//                      snapshot, and the torn/stale build must never be cached.
//   l2-del-fault       (Redis suites only) the accepted sync's cacheDel
//                      pipeline is the ONE Redis call that fails; the next
//                      GETs must not serve the pre-sync payload.
//   l2-undo-window     (Redis suites only) a build's fenced SET lands after
//                      the sync's DEL and its compensating DEL is delayed on
//                      the wire; a GET in that window must not read the
//                      losing row through into L1.
//
// Replay one seed:
//   STRESS_SEED=<seed> STRESS_ITER=1 STRESS_FAMILY=<family> \
//     deno test -A --no-check --config deno.json stress_progress_concurrency.test.ts
// Scale up: STRESS_ITER=700 (≈ 100 per family). Results (seed → outcome) land
// in artifacts/stress-progress/latest/<suite>.json (STRESS_OUT_DIR overrides).

import { assert } from "@std/assert";
import {
  type Actor,
  bootstrapActor,
  type CampaignReport,
  canonical,
  clockOffset,
  edgeRequest,
  envInt,
  expectedProgress,
  type Invariant,
  invariant,
  ipFor,
  type IterationRow,
  loadStressHarness,
  precommitShot,
  Prng,
  progressRequest,
  randomShotDetail,
  reservePermit,
  seedPracticeDays,
  setClockOffset,
  type ShotDetail,
  sleep,
  type StressHarness,
  syncRequest,
  timed,
  type TimedResult,
  todayUtc,
  wireShot,
  writeCampaign,
} from "./stress_progress_harness.ts";

export const FAMILIES = [
  "burst-cold",
  "read-write-race",
  "multi-user",
  "invalidation-gate",
  "logout-rotation",
  "clock-skew",
  "db-fault",
  "paging-torn",
  "l2-del-fault",
  "l2-undo-window",
  "l2-readthrough-race",
  "l2-coalesce-gap",
] as const;
export type Family = (typeof FAMILIES)[number];
const L2_ONLY_FAMILIES: ReadonlySet<Family> = new Set<Family>([
  "l2-del-fault",
  "l2-undo-window",
  "l2-readthrough-race",
  "l2-coalesce-gap",
]);
export function familiesFor(redis: boolean): Family[] {
  return FAMILIES.filter((f) => redis || !L2_ONLY_FAMILIES.has(f));
}

// ── Known (reproduced) defects ───────────────────────────────────────────────
// A BROKEN iteration stays BROKEN in the JSON table. When every failed
// invariant is explained by one of these, the row carries `knownDefect` so
// the suite can separate "documented, reproduced, tracked" from "new".
// Fixing a defect flips its pin test in stress_progress_redis.test.ts /
// stress_progress_concurrency.test.ts — remove the entry then.

export const KNOWN_DEFECTS = {
  /** readAllRows pages progress_daily with OFFSET/LIMIT; a write between
   * page 1 and page 2 shifts the ordering, so the stitched body carries a
   * duplicated (or dropped) series row. Only the racing caller sees it
   * (cacheSetFenced refuses to cache the torn build). */
  pagingTorn: "PROGRESS-PAGING-TORN-BODY",
  /** cacheDel bumps L1 and sends INCR gen + DEL row in one pipeline; when
   * that pipeline fails (Upstash 5xx / network) the L2 row survives and the
   * next L1 miss reads the pre-sync payload back into L1 for ≤ 60s. */
  l2DelFault: "PROGRESS-L2-INVALIDATION-NOT-DURABLE",
  /** cacheSetFenced SETs first and verifies the generation afterwards; a
   * reader between the losing SET and its compensating DEL reads the stale
   * row through into L1 for ≤ 60s. */
  l2UndoWindow: "PROGRESS-L2-FENCED-SET-UNDO-WINDOW",
  /** cacheGet reads L2 through into L1 (memorySet, ≤ 60s) with no generation
   * check. cacheDel clears L1 first and sends INCR gen + DEL afterwards; a
   * GET whose L2 read is applied after the L1 clear but before the DEL lands
   * (two independent Upstash HTTP calls in flight) copies the pre-sync row
   * back into L1 AFTER the invalidation — every later GET on this isolate
   * serves it until the read-through TTL lapses. */
  l2ReadThroughRace: "PROGRESS-L2-READTHROUGH-RACES-INVALIDATION",
  /** getProgress awaits the L2 read (cacheGet) BEFORE consulting the
   * single-flight map and never re-checks L1 afterwards. A request whose L2
   * read was in flight while the in-progress build completed finds the map
   * empty and runs a second identical build (2 more view reads) instead of
   * serving the row the first build just put into L1. Widest when the first
   * build's cacheFence failed (L1-only row, no L2 SET for the read to hit).
   * Efficiency only: the second build reads the same committed state. */
  coalesceGap: "PROGRESS-COALESCE-MISSES-L2-READ-IN-FLIGHT",
} as const;
export type KnownDefect = (typeof KNOWN_DEFECTS)[keyof typeof KNOWN_DEFECTS];

// ── Scenario context ─────────────────────────────────────────────────────────

interface SyncDelivery {
  result: TimedResult;
  shotIds: string[];
}

interface UserCtx {
  actor: Actor;
  precommitted: Set<string>;
  /** New (not precommitted) shot ids delivered by this iteration's syncs. */
  newShots: Map<string, ShotDetail>;
  deliveries: SyncDelivery[];
  gets: TimedResult[];
}

interface Ctx {
  h: StressHarness;
  prng: Prng;
  seed: number;
  latencyMs: number;
  invariants: Invariant[];
  results: TimedResult[];
  observations: Record<string, unknown>;
  scale: Record<string, number>;
  /** failed invariant name → known defect that explains it. */
  attributed: Map<string, KnownDefect>;
}

function note(ctx: Ctx, name: string, holds: boolean, detail = ""): void {
  ctx.invariants.push(invariant(name, holds, detail));
}

/** Record a failed invariant (already noted) as explained by a known defect. */
function attribute(ctx: Ctx, name: string, defect: KnownDefect | null): void {
  if (defect) ctx.attributed.set(name, defect);
}

/** Why a GET could have served the pre-sync payload for `userId`, if the
 * Redis logs show one of the three known L2 mechanisms. */
function staleL2Cause(
  ctx: Ctx,
  userId: string,
  beforeT = Number.POSITIVE_INFINITY,
): KnownDefect | null {
  if (failedDelsFor(ctx, userId, beforeT).length) {
    return KNOWN_DEFECTS.l2DelFault;
  }
  const key = `progress:${userId}`;
  const undo = ctx.h.redisPipelineLog.some(
    (p) => p.commands.length === 1 && p.commands[0] === `DEL ${key}`,
  );
  if (undo) return KNOWN_DEFECTS.l2UndoWindow;
  return readThroughRaces(ctx, userId, beforeT).length
    ? KNOWN_DEFECTS.l2ReadThroughRace
    : null;
}

interface BuildSpan {
  /** First page of progress_daily requested. */
  start: number;
  /** Last page (of either view) returned = the build's DB read is done. */
  end: number;
}

/** Builds of `userId`'s progress in start order, from the view page log.
 * Builds for one key never overlap (coalesce serialises them), so the pages
 * between two first-page reads belong to the earlier build. */
function buildSpans(ctx: Ctx, userId: string): BuildSpan[] {
  const pages = ctx.h.viewReadLog.filter((p) => p.userId === userId)
    .sort((a, b) => a.issued - b.issued);
  const starts = pages.filter((p) =>
    p.table === "progress_daily" && p.offset === 0
  ).map((p) => p.issued);
  return starts.map((start, i) => {
    const next = starts[i + 1] ?? Number.POSITIVE_INFINITY;
    const own = pages.filter((p) => p.issued >= start && p.issued < next);
    return { start, end: Math.max(start, ...own.map((p) => p.t)) };
  });
}

/** Builds (from 0-based build index `fromBuild`) whose triggering L2 read
 * (the latest applied `GET progress:<user>` before the build started) was
 * issued before the previous build had finished reading: the coalesce gap. */
function coalesceGaps(ctx: Ctx, userId: string, fromBuild = 1): string[] {
  const key = `progress:${userId}`;
  const reads = ctx.h.redisPipelineLog.filter((p) =>
    p.commands.some((c) => {
      const parts = c.split(" ");
      return parts[0] === "GET" && parts[1] === key;
    }) && !p.commands.some((c) => c.startsWith("SET "))
  );
  const spans = buildSpans(ctx, userId);
  const out: string[] = [];
  for (let k = fromBuild; k < spans.length; k += 1) {
    const prev = spans[k - 1];
    const cur = spans[k];
    const trigger = reads.filter((r) => r.t <= cur.start).at(-1);
    if (trigger && trigger.issued < prev.end) {
      out.push(
        `build#${k + 1}@${Math.round(cur.start)} triggered by L2 read issued@${
          Math.round(trigger.issued)
        } while build#${k} was still reading (done@${Math.round(prev.end)})`,
      );
    }
  }
  return out;
}

/** Every extra build of `userId` is a coalesce gap (no other cause). */
function onlyCoalesceGaps(ctx: Ctx, userId: string): boolean {
  const spans = buildSpans(ctx, userId);
  return spans.length > 1 &&
    coalesceGaps(ctx, userId).length === spans.length - 1;
}

/** Applied (GET row, DEL row) pipeline pairs where the read landed after the
 * invalidation had already cleared L1 (`del.issued`) but before the DEL was
 * applied (`del.t`): the reader copies the doomed row into L1. */
function readThroughRaces(
  ctx: Ctx,
  userId: string,
  beforeT = Number.POSITIVE_INFINITY,
): string[] {
  const key = `progress:${userId}`;
  const has = (c: string, name: string, k: string): boolean => {
    const parts = c.split(" ");
    return parts[0] === name && parts.slice(1).includes(k);
  };
  const log = ctx.h.redisPipelineLog;
  const dels = log.filter((p) =>
    p.commands.some((c) => has(c, "DEL", key)) &&
    p.commands.some((c) => has(c, "INCR", `gen:${key}`))
  );
  const reads = log.filter((p) =>
    p.commands.some((c) => has(c, "GET", key)) &&
    !p.commands.some((c) => c.startsWith("SET "))
  );
  const out: string[] = [];
  for (const d of dels) {
    for (const r of reads) {
      if (r.t < beforeT && d.issued < r.t && r.t < d.t) {
        out.push(
          `read@${Math.round(r.t)} inside del[issued ${
            Math.round(d.issued)
          } → applied ${Math.round(d.t)}]`,
        );
      }
    }
  }
  return out;
}

/** Run seeded-offset operations concurrently (Promise.all burst). */
async function schedule<T>(
  ops: Array<{ at: number; run: () => Promise<T> }>,
): Promise<T[]> {
  return await Promise.all(
    ops.map(async (op) => {
      if (op.at > 0) await sleep(op.at);
      return await op.run();
    }),
  );
}

async function newUser(
  ctx: Ctx,
  lane: number,
  precommit: number,
): Promise<UserCtx> {
  const actor = await bootstrapActor(ctx.h, ctx.prng, ipFor(ctx.seed, lane), {
    premium: true,
  });
  const precommitted = new Set<string>();
  for (let i = 0; i < precommit; i += 1) {
    const detail = randomShotDetail(ctx.prng, actor.userId, {
      lowConfidence: ctx.prng.next() < 0.15,
    });
    precommitShot(ctx.h, ctx.prng, detail);
    precommitted.add(detail.id);
  }
  seedPracticeDays(ctx.h, ctx.prng, actor.userId);
  return { actor, precommitted, newShots: new Map(), deliveries: [], gets: [] };
}

function committedIds(ctx: Ctx, userId: string): string[] {
  return ctx.h.fake.tables.shots.filter((s) => s.user_id === userId).map((s) =>
    String(s.id)
  );
}

function bodiesMatch(
  body: Record<string, unknown> | null,
  candidates: Set<string>,
): boolean {
  return body !== null && candidates.has(canonical(body));
}

function expectedSet(
  ctx: Ctx,
  userId: string,
  ids: Iterable<string>,
  todays: string[],
): Set<string> {
  const out = new Set<string>();
  for (const today of new Set(todays)) {
    out.add(canonical(expectedProgress(ctx.h, userId, ids, today)));
  }
  return out;
}

/** Read-your-writes / linearizable-snapshot check for every GET of a user:
 * the body must equal the oracle for some committed set S with
 * must ⊆ S ⊆ may, where must = shots whose accepted sync completed before
 * the GET started, may = shots some delivery of which started before the
 * GET ended. Enumerates the (small) optional set. */
function checkGetSnapshots(ctx: Ctx, user: UserCtx, todays: string[]): void {
  let ok = 0;
  let checked = 0;
  const failures: string[] = [];
  let maxOptional = 0;
  let unexplained = 0;
  for (const get of user.gets) {
    if (get.cancelled || get.status !== 200) continue;
    checked += 1;
    const must: string[] = [];
    const optional: string[] = [];
    for (const [id, detail] of user.newShots) {
      if (detail.resultKind !== "scored") continue;
      const deliveries = user.deliveries.filter((d) => d.shotIds.includes(id));
      const accepted = deliveries.filter((d) => {
        const ids = d.result.body?.acceptedIds;
        return Array.isArray(ids) && ids.includes(id);
      });
      if (accepted.length === 0) continue;
      const committedBy = Math.min(...accepted.map((d) => d.result.tEnd));
      const earliestStart = Math.min(...deliveries.map((d) => d.result.tStart));
      if (committedBy < get.tStart) must.push(id);
      else if (earliestStart < get.tEnd) optional.push(id);
    }
    maxOptional = Math.max(maxOptional, optional.length);
    const base = [...user.precommitted, ...must];
    const candidates = new Set<string>();
    if (optional.length <= 14) {
      for (let mask = 0; mask < 1 << optional.length; mask += 1) {
        const ids = [...base];
        for (let bit = 0; bit < optional.length; bit += 1) {
          if (mask & (1 << bit)) ids.push(optional[bit]);
        }
        for (const c of expectedSet(ctx, user.actor.userId, ids, todays)) {
          candidates.add(c);
        }
      }
    } else {
      for (const c of expectedSet(ctx, user.actor.userId, base, todays)) {
        candidates.add(c);
      }
      for (
        const c of expectedSet(
          ctx,
          user.actor.userId,
          [...base, ...optional],
          todays,
        )
      ) {
        candidates.add(c);
      }
    }
    if (bodiesMatch(get.body, candidates)) ok += 1;
    else {
      const cause = staleL2Cause(ctx, user.actor.userId, get.tEnd);
      if (cause === null) unexplained += 1;
      failures.push(
        `${get.label}: must=${must.length} optional=${optional.length}${
          cause ? ` [${cause}]` : ""
        } body=${canonical(get.body).slice(0, 400)}`,
      );
    }
  }
  ctx.observations[`maxOptional:${user.actor.userId.slice(0, 8)}`] =
    maxOptional;
  const name = `snapshot-consistent:${user.actor.userId.slice(0, 8)}`;
  note(
    ctx,
    name,
    failures.length === 0,
    failures.length
      ? failures.slice(0, 3).join(" | ")
      : `${ok}/${checked} GET bodies match an admissible snapshot`,
  );
  if (failures.length && unexplained === 0) {
    attribute(ctx, name, staleL2Cause(ctx, user.actor.userId));
  }
}

function checkCommonHealth(ctx: Ctx, allowed: Set<number>): void {
  const bad = ctx.results.filter((r) => !allowed.has(r.status));
  note(
    ctx,
    "statuses-in-contract",
    bad.length === 0,
    bad.length
      ? bad.map((r) => `${r.label}→${r.status}`).slice(0, 5).join(",")
      : `all ∈ {${[...allowed].join(",")}}`,
  );
  const hung = ctx.results.filter((r) => r.timedOut);
  note(
    ctx,
    "no-deadlock",
    hung.length === 0,
    hung.length ? `${hung.length} request(s) exceeded the wall-time bound` : "",
  );
  const slowest = Math.max(0, ...ctx.results.map((r) => r.tEnd - r.tStart));
  ctx.observations.slowestRequestMs = Math.round(slowest * 100) / 100;
  note(
    ctx,
    "bounded-latency",
    slowest < 4_000,
    `slowest ${Math.round(slowest)}ms`,
  );
}

function checkNoDuplicateRows(ctx: Ctx, user: UserCtx): void {
  const ids = committedIds(ctx, user.actor.userId);
  const distinct = new Set(ids);
  const expectedCount = user.precommitted.size +
    [...user.newShots.keys()].filter((id) =>
      user.deliveries.some((d) => {
        const accepted = d.result.body?.acceptedIds;
        return Array.isArray(accepted) && accepted.includes(id);
      })
    ).length;
  note(
    ctx,
    `no-duplicate-rows:${user.actor.userId.slice(0, 8)}`,
    ids.length === distinct.size && ids.length === expectedCount,
    `rows=${ids.length} distinct=${distinct.size} expected=${expectedCount}`,
  );
}

/** Failed (injected) Upstash pipelines that carried the cacheDel of this
 * user's progress row. cache.ts treats an unreachable Redis as "degrade":
 * the L1 copy is dropped but the L2 row survives, so the very next L1 miss
 * re-reads the stale row from L2. */
function failedDelsFor(
  ctx: Ctx,
  userId: string,
  beforeT = Number.POSITIVE_INFINITY,
): string[] {
  const key = `progress:${userId}`;
  return ctx.h.redisFaultLog
    .filter((f) =>
      f.t < beforeT &&
      f.commands.some((c) => c.startsWith("DEL ") && c.split(" ").includes(key))
    )
    .map((f) => `t=${Math.round(f.t)}`);
}

async function finalGet(
  ctx: Ctx,
  user: UserCtx,
  label: string,
): Promise<TimedResult> {
  const r = await timed(ctx.h, "get", label, progressRequest(user.actor));
  ctx.results.push(r);
  return r;
}

// ── Families ─────────────────────────────────────────────────────────────────

async function burstCold(ctx: Ctx): Promise<void> {
  const { h, prng } = ctx;
  const user = await newUser(ctx, 0, prng.int(0, 12));
  const burst = prng.int(8, 40);
  ctx.scale.burst = burst;
  const todayStart = todayUtc();
  const t0 = performance.now();
  const results = await schedule(
    Array.from({ length: burst }, (_, i) => ({
      at: prng.int(0, ctx.latencyMs * 2),
      run: () => {
        const cancel = prng.next() < 0.2;
        const abortAt = prng.next() < 0.1
          ? prng.int(0, ctx.latencyMs * 2)
          : null;
        const controller = abortAt === null ? null : new AbortController();
        if (controller && abortAt !== null) {
          setTimeout(() => controller.abort(), abortAt);
        }
        return timed(
          h,
          "get",
          `get#${i}${cancel ? ":cancel" : ""}${controller ? ":abort" : ""}`,
          progressRequest(
            user.actor,
            user.actor.accessToken,
            controller?.signal,
          ),
          { cancelBody: cancel },
        );
      },
    })),
  );
  const wall = performance.now() - t0;
  ctx.results.push(...results);
  user.gets.push(...results);
  const todays = [todayStart, todayUtc()];
  checkCommonHealth(ctx, new Set([200]));
  const expected = expectedSet(
    ctx,
    user.actor.userId,
    user.precommitted,
    todays,
  );
  const bodies = results.filter((r) => !r.cancelled);
  const mismatched = bodies.filter((r) => !bodiesMatch(r.body, expected));
  note(
    ctx,
    "identical-correct-bodies",
    mismatched.length === 0,
    mismatched.length
      ? `${mismatched.length}/${bodies.length} bodies differ from the oracle`
      : `${bodies.length} bodies == oracle`,
  );
  // With L2 on, a failed Redis call may cost one extra build (a fence taken
  // while L2 was unreachable keeps the row L1-only; a late arriver whose L2
  // GET failed falls through to a fresh build). Never more than that.
  const buildBound = 1 + h.redisFaults;
  note(
    ctx,
    "single-flight",
    h.reads.progress_daily <= buildBound &&
      h.reads.practice_days === h.reads.progress_daily,
    `progress_daily reads=${h.reads.progress_daily} practice_days reads=${h.reads.practice_days} for ${burst} concurrent GETs (bound 1 + ${h.redisFaults} redis faults)`,
  );
  note(ctx, "burst-wall-time", wall < 4_000, `${Math.round(wall)}ms`);
  // Warm wave: nothing may rebuild (L1 is warm in this isolate).
  const buildsBeforeWarm = h.reads.progress_daily;
  const warm = await schedule(
    Array.from({ length: prng.int(2, 6) }, (_, i) => ({
      at: prng.int(0, ctx.latencyMs),
      run: () => timed(h, "get", `warm#${i}`, progressRequest(user.actor)),
    })),
  );
  ctx.results.push(...warm);
  note(
    ctx,
    "warm-cache-no-rebuild",
    h.reads.progress_daily === buildsBeforeWarm &&
      warm.every((r) => r.status === 200 && bodiesMatch(r.body, expected)),
    `builds ${buildsBeforeWarm}→${h.reads.progress_daily} across ${warm.length} warm GETs`,
  );
}

async function readWriteRace(ctx: Ctx, userCount: number): Promise<void> {
  const { h, prng } = ctx;
  const users: UserCtx[] = [];
  for (let u = 0; u < userCount; u += 1) {
    users.push(await newUser(ctx, u, prng.int(0, 6)));
  }
  ctx.scale.users = userCount;
  const spread = ctx.latencyMs * 12 + 20;
  const todayStart = todayUtc();
  const ops: Array<{ at: number; run: () => Promise<unknown> }> = [];
  let gets = 0;
  let syncs = 0;
  for (const user of users) {
    const g = prng.int(6, 20);
    const s = prng.int(1, 5);
    gets += g;
    syncs += s;
    for (let i = 0; i < g; i += 1) {
      ops.push({
        at: prng.int(0, spread),
        run: async () => {
          const r = await timed(
            h,
            "get",
            `u${users.indexOf(user)}:get#${i}`,
            progressRequest(user.actor),
            {
              cancelBody: prng.next() < 0.1,
            },
          );
          user.gets.push(r);
          ctx.results.push(r);
        },
      });
    }
    for (let i = 0; i < s; i += 1) {
      const shots: Array<Record<string, unknown>> = [];
      const ids: string[] = [];
      const count = prng.int(1, 3);
      for (let k = 0; k < count; k += 1) {
        const roll = prng.next();
        if (roll < 0.15 && user.precommitted.size > 0) {
          // Replay of an already committed shot.
          const id =
            [...user.precommitted][prng.int(0, user.precommitted.size - 1)];
          const detail = h.details.get(id)!;
          const permitId = String(
            h.fake.tables.shots.find((row) => row.id === id)
              ?.analysis_permit_id ?? "",
          );
          shots.push(wireShot(detail, permitId));
          ids.push(id);
          continue;
        }
        const detail = randomShotDetail(prng, user.actor.userId, {
          lowConfidence: roll < 0.3,
        });
        h.details.set(detail.id, detail);
        user.newShots.set(detail.id, detail);
        const permitId = reservePermit(h, prng, user.actor.userId);
        shots.push(wireShot(detail, permitId));
        ids.push(detail.id);
      }
      const deliver = (label: string) => ({
        at: prng.int(0, spread),
        run: async () => {
          const r = await timed(
            h,
            "sync",
            label,
            syncRequest(user.actor, shots),
          );
          user.deliveries.push({ result: r, shotIds: ids });
          ctx.results.push(r);
        },
      });
      ops.push(deliver(`u${users.indexOf(user)}:sync#${i}`));
      if (prng.next() < 0.25) {
        // Duplicate delivery of the same batch (outbox retry racing itself).
        syncs += 1;
        ops.push(deliver(`u${users.indexOf(user)}:sync#${i}:dup`));
      }
    }
  }
  ctx.scale.gets = gets;
  ctx.scale.syncs = syncs;
  await schedule(prng.shuffle(ops));
  const todays = [todayStart, todayUtc()];
  checkCommonHealth(ctx, new Set([200]));
  for (const user of users) {
    const tag = user.actor.userId.slice(0, 8);
    const rejected = user.deliveries.filter((d) => {
      const list = d.result.body?.rejected;
      return !Array.isArray(list) || list.length > 0;
    });
    note(
      ctx,
      `syncs-accepted:${tag}`,
      rejected.length === 0,
      rejected.length
        ? `${rejected.length} sync(s) rejected shots: ${
          JSON.stringify(rejected[0].result.body).slice(0, 300)
        }`
        : `${user.deliveries.length} deliveries all accepted`,
    );
    checkNoDuplicateRows(ctx, user);
    checkGetSnapshots(ctx, user, todays);
    const evidenceSyncs = user.deliveries.filter((d) => {
      const accepted = d.result.body?.acceptedIds;
      return Array.isArray(accepted) && accepted.length > 0;
    }).length;
    const reads = h.readsByUser.get(user.actor.userId) ??
      { progress_daily: 0, practice_days: 0 };
    // Every failed Redis pipeline may cost at most one extra rebuild (a fence
    // taken while L2 was unreachable is never trusted for the L2 write).
    const bound = 1 + evidenceSyncs + h.redisFaults;
    note(
      ctx,
      `builds-bounded:${tag}`,
      reads.progress_daily <= bound &&
        reads.practice_days === reads.progress_daily,
      `builds=${reads.progress_daily} (practice_days reads=${reads.practice_days}) ≤ 1 + ${evidenceSyncs} invalidations + ${h.redisFaults} redis faults`,
    );
    const final = await finalGet(ctx, user, `u${tag}:final`);
    const expected = expectedSet(
      ctx,
      user.actor.userId,
      committedIds(ctx, user.actor.userId),
      [todayUtc()],
    );
    const finalOk = final.status === 200 && bodiesMatch(final.body, expected);
    const cause = finalOk ? null : staleL2Cause(ctx, user.actor.userId);
    note(
      ctx,
      `final-read-your-writes:${tag}`,
      finalOk,
      `status=${final.status}${
        finalOk ? "" : ` stale body${cause ? ` [${cause}]` : ""}`
      }`,
    );
    attribute(ctx, `final-read-your-writes:${tag}`, cause);
  }
}

async function invalidationGate(ctx: Ctx): Promise<void> {
  const { h, prng } = ctx;
  const user = await newUser(ctx, 0, prng.int(0, 5));
  const todayStart = todayUtc();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const reachedGate = new Promise<void>((resolve) => (reached = resolve));
  const gatedTable = prng.next() < 0.5 ? "progress_daily" : "practice_days";
  let parked = false;
  h.faults.hold = (table) => {
    if (!parked && table === gatedTable) {
      parked = true;
      reached();
      return gate;
    }
    return null;
  };
  ctx.observations.gatedTable = gatedTable;
  const stale = timed(h, "get", "get:stale-build", progressRequest(user.actor));
  await reachedGate;
  const detail = randomShotDetail(prng, user.actor.userId);
  h.details.set(detail.id, detail);
  user.newShots.set(detail.id, detail);
  const sync = await timed(
    h,
    "sync",
    "sync:during-build",
    syncRequest(user.actor, [
      wireShot(detail, reservePermit(h, prng, user.actor.userId)),
    ]),
  );
  ctx.results.push(sync);
  user.deliveries.push({ result: sync, shotIds: [detail.id] });
  // Between the sync landing and the stale build resuming: 0..N post-sync GETs.
  const postCount = prng.int(1, 4);
  const posts = schedule(
    Array.from({ length: postCount }, (_, i) => ({
      at: prng.int(0, ctx.latencyMs * 2),
      run: () =>
        timed(h, "get", `get:post-sync#${i}`, progressRequest(user.actor)),
    })),
  );
  await sleep(prng.int(0, ctx.latencyMs * 3) + 5);
  release();
  const [staleResult, postResults] = await Promise.all([stale, posts]);
  ctx.results.push(staleResult, ...postResults);
  user.gets.push(staleResult, ...postResults);
  const todays = [todayStart, todayUtc()];
  checkCommonHealth(ctx, new Set([200]));
  const fresh = expectedSet(ctx, user.actor.userId, [
    ...user.precommitted,
    detail.id,
  ], todays);
  const pre = expectedSet(ctx, user.actor.userId, user.precommitted, todays);
  note(
    ctx,
    "post-sync-gets-see-sync",
    postResults.every((r) => bodiesMatch(r.body, fresh)),
    `${
      postResults.filter((r) => bodiesMatch(r.body, fresh)).length
    }/${postResults.length} post-sync GETs returned the post-sync payload`,
  );
  note(
    ctx,
    "stale-build-admissible",
    bodiesMatch(staleResult.body, pre) || bodiesMatch(staleResult.body, fresh),
    "the parked build's own caller may see either snapshot",
  );
  const readsBefore = h.reads.progress_daily;
  const after = await finalGet(ctx, user, "get:after");
  note(
    ctx,
    "stale-never-cached",
    after.status === 200 && bodiesMatch(after.body, fresh) &&
      h.reads.progress_daily === readsBefore,
    `final GET served post-sync payload from cache (reads ${readsBefore}→${h.reads.progress_daily})`,
  );
  // Build 1 = the parked pre-sync build, build 2 = the first post-sync GET.
  // Anything beyond is a post-sync GET that failed to join build 2.
  const buildsOk = h.reads.progress_daily === 2 && h.reads.practice_days === 2;
  const gaps = h.redisEnabled ? coalesceGaps(ctx, user.actor.userId, 2) : [];
  ctx.observations.coalesceGaps = gaps;
  note(
    ctx,
    "exactly-two-builds",
    buildsOk,
    `progress_daily=${h.reads.progress_daily} practice_days=${h.reads.practice_days} (${postCount} post-sync GETs)${
      gaps.length ? `; ${gaps.join("; ")}` : ""
    }`,
  );
  if (
    !buildsOk && h.reads.progress_daily === h.reads.practice_days &&
    h.reads.progress_daily > 2 &&
    gaps.length === h.reads.progress_daily - 2
  ) {
    attribute(ctx, "exactly-two-builds", KNOWN_DEFECTS.coalesceGap);
  }
  if (h.redisEnabled) {
    const l2 = h.redis.get(`progress:${user.actor.userId}`);
    let l2Fresh = true;
    if (l2) {
      try {
        l2Fresh = fresh.has(canonical(JSON.parse(l2.value)));
      } catch {
        l2Fresh = false;
      }
    }
    note(
      ctx,
      "l2-holds-no-stale-row",
      l2Fresh,
      l2 ? "L2 row equals post-sync payload" : "no L2 row",
    );
  }
}

async function logoutRotation(ctx: Ctx): Promise<void> {
  const { h, prng } = ctx;
  const user = await newUser(ctx, 0, prng.int(0, 6));
  const todayStart = todayUtc();
  if (prng.next() < 0.5) {
    const warm = await finalGet(ctx, user, "get:warm");
    assert(warm.status === 200, `warm GET ${warm.status}`);
  }
  const mode = prng.next() < 0.5 ? "logout" : "refresh";
  ctx.observations.mode = mode;
  const spread = ctx.latencyMs * 10 + 20;
  const gets = prng.int(6, 16);
  ctx.scale.gets = gets;
  const ops: Array<{ at: number; run: () => Promise<unknown> }> = [];
  const oldToken = user.actor.accessToken;
  for (let i = 0; i < gets; i += 1) {
    ops.push({
      at: prng.int(0, spread),
      run: async () => {
        const r = await timed(
          h,
          "get",
          `get#${i}`,
          progressRequest(user.actor, oldToken),
        );
        ctx.results.push(r);
        user.gets.push(r);
      },
    });
  }
  let pivot: TimedResult | null = null;
  const postPivot: TimedResult[] = [];
  if (mode === "logout") {
    ops.push({
      at: prng.int(spread / 4, (spread * 3) / 4),
      run: async () => {
        pivot = await timed(
          h,
          "logout",
          "logout",
          edgeRequest("POST", "/v1/auth/logout", {
            token: oldToken,
            ip: user.actor.ip,
          }),
        );
        ctx.results.push(pivot);
      },
    });
    // A sync racing the logout.
    const detail = randomShotDetail(prng, user.actor.userId);
    h.details.set(detail.id, detail);
    user.newShots.set(detail.id, detail);
    ops.push({
      at: prng.int(0, spread),
      run: async () => {
        const r = await timed(
          h,
          "sync",
          "sync:racing-logout",
          syncRequest(user.actor, [
            wireShot(detail, reservePermit(h, prng, user.actor.userId)),
          ]),
        );
        ctx.results.push(r);
        user.deliveries.push({ result: r, shotIds: [detail.id] });
      },
    });
  } else {
    ops.push({
      at: prng.int(spread / 4, (spread * 3) / 4),
      run: async () => {
        pivot = await timed(
          h,
          "refresh",
          "refresh",
          edgeRequest("POST", "/v1/auth/refresh", {
            ip: user.actor.ip,
            body: { refreshToken: user.actor.refreshToken },
          }),
        );
        ctx.results.push(pivot);
        const session = pivot.body && typeof pivot.body.session === "object"
          ? (pivot.body.session as Record<string, unknown>)
          : {};
        const newToken = String(session.accessToken ?? "");
        if (!newToken) return;
        const after = await schedule(
          Array.from({ length: prng.int(2, 6) }, (_, i) => ({
            at: prng.int(0, ctx.latencyMs * 3),
            run: () =>
              timed(
                h,
                "get",
                `get:new-token#${i}`,
                progressRequest(user.actor, newToken),
              ),
          })),
        );
        postPivot.push(...after);
        ctx.results.push(...after);
        user.gets.push(...after);
      },
    });
  }
  await schedule(prng.shuffle(ops));
  const todays = [todayStart, todayUtc()];
  const p = pivot as TimedResult | null;
  assert(p, "pivot request did not run");
  if (mode === "logout") {
    checkCommonHealth(ctx, new Set([200, 204, 401]));
    note(ctx, "logout-succeeded", p.status === 204, `logout → ${p.status}`);
    const after = ctx.results.filter((r) =>
      r.kind !== "logout" && r.tStart > p.tEnd
    );
    const before = ctx.results.filter((r) =>
      r.kind !== "logout" && r.tEnd < p.tStart
    );
    note(
      ctx,
      "post-logout-refused",
      after.every((r) => r.status === 401),
      `${
        after.filter((r) => r.status === 401).length
      }/${after.length} requests started after logout completed were 401`,
    );
    note(
      ctx,
      "pre-logout-served",
      before.every((r) => r.status === 200),
      `${
        before.filter((r) => r.status === 200).length
      }/${before.length} requests finished before logout started were 200`,
    );
    // 200 GET bodies must still be admissible snapshots (sync may or may not have landed).
    checkGetSnapshots(ctx, user, todays);
    const afterBodies = after.filter((r) =>
      r.kind === "get" && r.body && "series" in r.body
    );
    note(
      ctx,
      "no-progress-body-after-logout",
      afterBodies.length === 0,
      `${afterBodies.length} progress bodies leaked after logout`,
    );
  } else {
    checkCommonHealth(ctx, new Set([200]));
    note(ctx, "refresh-succeeded", p.status === 200, `refresh → ${p.status}`);
    note(
      ctx,
      "new-token-served",
      postPivot.length > 0 && postPivot.every((r) => r.status === 200),
      `${postPivot.length} GETs with the rotated token`,
    );
    checkGetSnapshots(ctx, user, todays);
    const reads = h.readsByUser.get(user.actor.userId) ?? { progress_daily: 0 };
    const gaps = coalesceGaps(ctx, user.actor.userId);
    ctx.observations.coalesceGaps = gaps;
    note(
      ctx,
      "rotation-does-not-rebuild",
      reads.progress_daily === 1,
      `builds=${reads.progress_daily} (token rotation must not bust the per-user key)${
        gaps.length ? `; ${gaps.join("; ")}` : ""
      }`,
    );
    if (reads.progress_daily > 1 && onlyCoalesceGaps(ctx, user.actor.userId)) {
      attribute(ctx, "rotation-does-not-rebuild", KNOWN_DEFECTS.coalesceGap);
    }
  }
}

const SKEWS_MS = [0, 30_000, 61_000, 11 * 60_000, 2 * 3_600_000, -90_000];

async function clockSkew(ctx: Ctx): Promise<void> {
  const { h, prng } = ctx;
  const user = await newUser(ctx, 0, prng.int(0, 8));
  const todayStart = todayUtc();
  const warm = prng.next() < 0.7;
  if (warm) {
    const w = await finalGet(ctx, user, "get:warm");
    assert(w.status === 200, `warm GET ${w.status}`);
  }
  const skew = SKEWS_MS[prng.int(0, SKEWS_MS.length - 1)];
  ctx.observations.skewMs = skew;
  ctx.observations.warm = warm;
  const spread = ctx.latencyMs * 10 + 20;
  const gets = prng.int(6, 16);
  ctx.scale.gets = gets;
  let tSkew = Infinity;
  const ops: Array<{ at: number; run: () => Promise<unknown> }> = [];
  for (let i = 0; i < gets; i += 1) {
    ops.push({
      at: prng.int(0, spread),
      run: async () => {
        const r = await timed(
          h,
          "get",
          `get#${i}`,
          progressRequest(user.actor),
        );
        ctx.results.push(r);
        user.gets.push(r);
      },
    });
  }
  ops.push({
    at: prng.int(spread / 4, (spread * 3) / 4),
    run: () => {
      tSkew = performance.now();
      setClockOffset(skew);
      return Promise.resolve();
    },
  });
  const skewedToday = () => new Date().toISOString().slice(0, 10);
  await schedule(prng.shuffle(ops));
  const todays = [todayStart, skewedToday(), todayUtc()];
  const expired = skew >= 3_600_000;
  checkCommonHealth(ctx, new Set(expired ? [200, 401] : [200]));
  const after = user.gets.filter((r) => r.tStart > tSkew);
  const before = user.gets.filter((r) => r.tEnd < tSkew);
  note(
    ctx,
    "pre-skew-served",
    before.every((r) => r.status === 200),
    `${before.length} GETs before the jump`,
  );
  if (expired) {
    note(
      ctx,
      "expired-bearer-refused-after-jump",
      after.every((r) => r.status === 401),
      `${
        after.filter((r) => r.status === 401).length
      }/${after.length} post-jump GETs were 401 (bearer exp passed)`,
    );
  } else {
    note(
      ctx,
      "post-skew-served",
      after.every((r) => r.status === 200),
      `${after.length} GETs after the jump`,
    );
  }
  const expected = expectedSet(
    ctx,
    user.actor.userId,
    user.precommitted,
    todays,
  );
  const bodies = user.gets.filter((r) => r.status === 200);
  const mismatched = bodies.filter((r) => !bodiesMatch(r.body, expected));
  note(
    ctx,
    "bodies-correct-under-skew",
    mismatched.length === 0,
    mismatched.length
      ? canonical(mismatched[0].body).slice(0, 300)
      : `${bodies.length} bodies`,
  );
  const post200 = after.filter((r) => r.status === 200);
  if (skew >= 61_000 && !expired && post200.length > 0) {
    if (h.redisEnabled) {
      // L2 keeps its own clock: the row is still alive there, so the skewed
      // isolate must read it through rather than rebuild (bodies checked above).
      note(
        ctx,
        "skewed-isolate-reads-l2-through",
        h.reads.progress_daily === 1 || h.redisFaults > 0,
        `builds=${h.reads.progress_daily} redisFaults=${h.redisFaults} after a ${
          skew / 1000
        }s isolate-only jump`,
      );
    } else {
      note(
        ctx,
        "ttl-expiry-rebuilds",
        h.reads.progress_daily >= 2,
        `builds=${h.reads.progress_daily} after a ${
          skew / 1000
        }s jump (60s TTL must have lapsed)`,
      );
    }
  }
  // Still under the skewed clock: the route must keep working (a rebuild
  // under skew must be correct for the skewed "today").
  if (!expired) {
    const again = await finalGet(ctx, user, "get:under-skew");
    const expectedNow = expectedSet(ctx, user.actor.userId, user.precommitted, [
      todayStart,
      skewedToday(),
    ]);
    note(
      ctx,
      "serves-under-skew",
      again.status === 200 && bodiesMatch(again.body, expectedNow),
      `status=${again.status}`,
    );
  }
  setClockOffset(0);
}

async function dbFault(ctx: Ctx): Promise<void> {
  const { h, prng } = ctx;
  const user = await newUser(ctx, 0, prng.int(0, 8));
  const todayStart = todayUtc();
  const p = 0.3 + prng.next() * 0.4;
  ctx.observations.failProbability = Math.round(p * 100) / 100;
  let failures = 0;
  const faultPrng = new Prng(ctx.seed ^ 0x5bd1e995);
  h.faults.fail = () => {
    const fail = faultPrng.next() < p;
    if (fail) failures += 1;
    return fail;
  };
  const gets = prng.int(6, 20);
  ctx.scale.gets = gets;
  const spread = ctx.latencyMs * 10 + 20;
  const results = await schedule(
    Array.from({ length: gets }, (_, i) => ({
      at: prng.int(0, spread),
      run: () => timed(h, "get", `get#${i}`, progressRequest(user.actor)),
    })),
  );
  ctx.results.push(...results);
  user.gets.push(...results);
  h.faults = {};
  const todays = [todayStart, todayUtc()];
  checkCommonHealth(ctx, new Set([200, 503]));
  const expected = expectedSet(
    ctx,
    user.actor.userId,
    user.precommitted,
    todays,
  );
  const ok = results.filter((r) => r.status === 200);
  note(
    ctx,
    "200-bodies-correct",
    ok.every((r) => bodiesMatch(r.body, expected)),
    `${ok.length} successful bodies`,
  );
  const unavailable = results.filter((r) => r.status === 503);
  note(
    ctx,
    "503-only-when-a-read-failed",
    unavailable.length === 0 || failures > 0,
    `503s=${unavailable.length} failedReads=${failures}`,
  );
  note(
    ctx,
    "5xx-body-generic",
    unavailable.every((r) =>
      !JSON.stringify(r.body ?? {}).includes("simulated")
    ),
    "no upstream detail leaks into 503 bodies",
  );
  ctx.observations.failedReads = failures;
  ctx.observations.unavailable = unavailable.length;
  const readsBefore = h.reads.progress_daily;
  const final = await finalGet(ctx, user, "get:recovered");
  note(
    ctx,
    "recovers-after-fault",
    final.status === 200 && bodiesMatch(final.body, expected),
    `status=${final.status}`,
  );
  if (unavailable.length > 0 && ok.length === 0) {
    note(
      ctx,
      "503-not-cached",
      h.reads.progress_daily > readsBefore,
      `a failed build must not populate the cache (reads ${readsBefore}→${h.reads.progress_daily})`,
    );
  }
}

const PAGE_ROWS = 1_000;

async function pagingTorn(ctx: Ctx): Promise<void> {
  const { h, prng } = ctx;
  const user = await newUser(ctx, 0, 0);
  const todayStart = todayUtc();
  // > one PostgREST page of distinct (day, shot_type, version) groups, none
  // of them today so the racing sync creates a brand-new first row.
  const groups = prng.int(PAGE_ROWS + 1, PAGE_ROWS * 2 - 100);
  ctx.scale.seriesRows = groups;
  let made = 0;
  for (let daysAgo = 1; made < groups; daysAgo += 1) {
    for (const shotType of SHOT_TYPE_POOL) {
      for (const version of VERSION_POOL) {
        if (made >= groups) break;
        const detail: ShotDetail = {
          id: prng.uuid(),
          userId: user.actor.userId,
          shotType,
          capturedAt: new Date(Date.now() - daysAgo * 86_400_000 - 3_600_000)
            .toISOString(),
          overallScore: prng.int(0, 100) / 10,
          scoringModelVersion: version,
          resultKind: "scored",
        };
        precommitShot(h, prng, detail);
        user.precommitted.add(detail.id);
        made += 1;
      }
    }
  }
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const reachedGate = new Promise<void>((resolve) => (reached = resolve));
  let parked = false;
  h.faults.hold = (table, _userId, offset) => {
    if (!parked && table === "progress_daily" && offset > 0) {
      parked = true;
      reached();
      return gate;
    }
    return null;
  };
  const stale = timed(
    h,
    "get",
    "get:parked-on-page-2",
    progressRequest(user.actor),
  );
  await reachedGate;
  const detail: ShotDetail = {
    ...randomShotDetail(prng, user.actor.userId, { daySpan: 0 }),
    capturedAt: new Date().toISOString(),
  };
  h.details.set(detail.id, detail);
  user.newShots.set(detail.id, detail);
  const sync = await timed(
    h,
    "sync",
    "sync:between-pages",
    syncRequest(user.actor, [
      wireShot(detail, reservePermit(h, prng, user.actor.userId)),
    ]),
  );
  ctx.results.push(sync);
  user.deliveries.push({ result: sync, shotIds: [detail.id] });
  const posts = schedule(
    Array.from({ length: prng.int(1, 3) }, (_, i) => ({
      at: prng.int(0, ctx.latencyMs * 2),
      run: () =>
        timed(h, "get", `get:post-sync#${i}`, progressRequest(user.actor)),
    })),
  );
  await sleep(prng.int(0, ctx.latencyMs * 3) + 5);
  release();
  const [staleResult, postResults] = await Promise.all([stale, posts]);
  ctx.results.push(staleResult, ...postResults);
  const todays = [todayStart, todayUtc()];
  checkCommonHealth(ctx, new Set([200]));
  note(
    ctx,
    "sync-accepted",
    sync.status === 200 && Array.isArray(sync.body?.acceptedIds) &&
      (sync.body?.acceptedIds as string[]).includes(detail.id),
    `sync → ${sync.status}`,
  );
  const pre = expectedSet(ctx, user.actor.userId, user.precommitted, todays);
  const fresh = expectedSet(ctx, user.actor.userId, [
    ...user.precommitted,
    detail.id,
  ], todays);
  const staleSeries = Array.isArray(staleResult.body?.series)
    ? (staleResult.body?.series as unknown[])
    : [];
  const staleKeys = staleSeries.map((row) => canonical(row));
  const duplicates = staleKeys.length - new Set(staleKeys).size;
  ctx.observations.parkedBodyRows = staleSeries.length;
  ctx.observations.parkedBodyDuplicateRows = duplicates;
  ctx.observations.pageReads = h.pageReads.progress_daily;
  const snapshot = bodiesMatch(staleResult.body, pre) ||
    bodiesMatch(staleResult.body, fresh);
  note(
    ctx,
    "parked-build-body-is-a-snapshot",
    snapshot,
    `stitched ${staleSeries.length} rows (${duplicates} duplicated) for ${groups} pre-sync groups; matches pre=${
      bodiesMatch(staleResult.body, pre)
    } fresh=${bodiesMatch(staleResult.body, fresh)}`,
  );
  // Torn = the stitched pages carry a duplicated or dropped row and nothing
  // else is wrong with the response (status 200, streak intact).
  if (
    !snapshot && staleResult.status === 200 &&
    (duplicates > 0 || staleSeries.length !== groups)
  ) {
    attribute(ctx, "parked-build-body-is-a-snapshot", KNOWN_DEFECTS.pagingTorn);
  }
  note(
    ctx,
    "post-sync-gets-see-sync",
    postResults.every((r) => bodiesMatch(r.body, fresh)),
    `${
      postResults.filter((r) => bodiesMatch(r.body, fresh)).length
    }/${postResults.length}`,
  );
  const readsBefore = h.reads.progress_daily;
  const after = await finalGet(ctx, user, "get:after");
  note(
    ctx,
    "torn-or-stale-never-cached",
    after.status === 200 && bodiesMatch(after.body, fresh) &&
      h.reads.progress_daily === readsBefore,
    `final GET fresh from cache (builds ${readsBefore}→${h.reads.progress_daily})`,
  );
  note(
    ctx,
    "exactly-two-builds",
    h.reads.progress_daily === 2,
    `builds=${h.reads.progress_daily} pageReads=${h.pageReads.progress_daily}`,
  );
}

function pipelineHas(
  commands: Array<Array<string>>,
  name: string,
  key: string,
): boolean {
  return commands.some((c) =>
    String(c[0]).toUpperCase() === name && c.slice(1).includes(key)
  );
}

/** One accepted sync whose cacheDel pipeline (INCR gen / EXPIRE / DEL row) is
 * the only Redis call that fails. Shape: warm → sync → GET burst → GET. */
async function l2DelFault(ctx: Ctx): Promise<void> {
  const { h, prng } = ctx;
  h.redisFault = () => null; // deterministic: only the one fault below
  const user = await newUser(ctx, 0, prng.int(1, 8));
  const key = `progress:${user.actor.userId}`;
  const todayStart = todayUtc();
  const warm = await finalGet(ctx, user, "get:warm");
  note(ctx, "warm-row-landed-in-l2", h.redis.has(key), `l2 has ${key}`);
  const pre = expectedSet(ctx, user.actor.userId, user.precommitted, [
    todayStart,
  ]);
  note(
    ctx,
    "warm-correct",
    warm.status === 200 && bodiesMatch(warm.body, pre),
    `status=${warm.status}`,
  );
  let failed = 0;
  h.redisFault = (commands) => {
    if (
      failed === 0 && pipelineHas(commands, "DEL", key) &&
      pipelineHas(commands, "INCR", `gen:${key}`)
    ) {
      failed += 1;
      return prng.next() < 0.5 ? "http500" : "throw";
    }
    return null;
  };
  const detail = randomShotDetail(prng, user.actor.userId, {
    lowConfidence: false,
  });
  h.details.set(detail.id, detail);
  user.newShots.set(detail.id, detail);
  const sync = await timed(
    h,
    "sync",
    "sync",
    syncRequest(user.actor, [
      wireShot(detail, reservePermit(h, prng, user.actor.userId)),
    ]),
  );
  ctx.results.push(sync);
  user.deliveries.push({ result: sync, shotIds: [detail.id] });
  note(
    ctx,
    "sync-accepted",
    sync.status === 200 && Array.isArray(sync.body?.acceptedIds) &&
      (sync.body?.acceptedIds as string[]).includes(detail.id),
    `sync → ${sync.status}`,
  );
  note(
    ctx,
    "del-pipeline-was-failed",
    failed === 1,
    `failed=${failed} (redisFaults=${h.redisFaults})`,
  );
  const burst = prng.int(2, 8);
  ctx.scale.burst = burst;
  const gets = await schedule(
    Array.from({ length: burst }, (_, i) => ({
      at: prng.int(0, ctx.latencyMs * 2),
      run: () =>
        timed(h, "get", `get:post-sync#${i}`, progressRequest(user.actor)),
    })),
  );
  ctx.results.push(...gets);
  const todays = [todayStart, todayUtc()];
  const fresh = expectedSet(ctx, user.actor.userId, [
    ...user.precommitted,
    detail.id,
  ], todays);
  const stale = gets.filter((r) =>
    bodiesMatch(
      r.body,
      expectedSet(ctx, user.actor.userId, user.precommitted, todays),
    )
  );
  checkCommonHealth(ctx, new Set([200]));
  const allFresh = gets.every((r) =>
    r.status === 200 && bodiesMatch(r.body, fresh)
  );
  note(
    ctx,
    "post-sync-gets-fresh",
    allFresh,
    `${
      gets.filter((r) => bodiesMatch(r.body, fresh)).length
    }/${gets.length} fresh, ${stale.length} served the PRE-SYNC payload (L2 row survived the failed DEL and was read through into L1)`,
  );
  // Attributable only when every non-fresh body is exactly the pre-sync payload.
  if (
    !allFresh &&
    gets.every((r) =>
      r.status === 200 && (bodiesMatch(r.body, fresh) || stale.includes(r))
    )
  ) {
    attribute(ctx, "post-sync-gets-fresh", KNOWN_DEFECTS.l2DelFault);
  }
  const later = await finalGet(ctx, user, "get:later");
  const laterStale = later.status === 200 &&
    bodiesMatch(
      later.body,
      expectedSet(ctx, user.actor.userId, user.precommitted, todays),
    );
  note(
    ctx,
    "later-get-fresh",
    later.status === 200 && bodiesMatch(later.body, fresh),
    laterStale
      ? "still the pre-sync payload (L1 read-through copy, ≤ 60s)"
      : `status=${later.status}`,
  );
  if (laterStale) attribute(ctx, "later-get-fresh", KNOWN_DEFECTS.l2DelFault);
  ctx.observations.l2RowAfter = h.redis.has(key) ? "present" : "absent";
}

/** cacheSetFenced loses the race (its SET lands after the sync's DEL) and
 * undoes with a compensating DEL that we delay on the wire; a GET between
 * the losing SET and the undo reads the stale row. Shape: cold GET (parked
 * at its fenced SET) → sync → release SET → park the undo DEL → GET →
 * release → GET. */
async function l2UndoWindow(ctx: Ctx): Promise<void> {
  const { h, prng } = ctx;
  const user = await newUser(ctx, 0, prng.int(1, 8));
  const key = `progress:${user.actor.userId}`;
  const todayStart = todayUtc();
  let releaseSet!: () => void;
  const setGate = new Promise<void>((resolve) => (releaseSet = resolve));
  let setParked!: () => void;
  const setParkedP = new Promise<void>((resolve) => (setParked = resolve));
  let releaseUndo!: () => void;
  const undoGate = new Promise<void>((resolve) => (releaseUndo = resolve));
  let undoParked!: () => void;
  const undoParkedP = new Promise<void>((resolve) => (undoParked = resolve));
  let sets = 0;
  let undos = 0;
  h.redisFault = () => null; // deterministic: only the wire delays below
  h.redisHold = (commands) => {
    if (pipelineHas(commands, "SET", key) && sets === 0) {
      sets += 1;
      setParked();
      return setGate;
    }
    if (
      commands.length === 1 && pipelineHas(commands, "DEL", key) && undos === 0
    ) {
      undos += 1;
      undoParked();
      return undoGate;
    }
    return null;
  };
  const cold = timed(
    h,
    "get",
    "get:cold-parked-at-set",
    progressRequest(user.actor),
  );
  await Promise.race([setParkedP, sleep(3_000)]);
  note(ctx, "fenced-set-reached", sets === 1, `sets=${sets}`);
  const detail = randomShotDetail(prng, user.actor.userId, {
    lowConfidence: false,
  });
  h.details.set(detail.id, detail);
  user.newShots.set(detail.id, detail);
  const sync = await timed(
    h,
    "sync",
    "sync",
    syncRequest(user.actor, [
      wireShot(detail, reservePermit(h, prng, user.actor.userId)),
    ]),
  );
  ctx.results.push(sync);
  user.deliveries.push({ result: sync, shotIds: [detail.id] });
  note(
    ctx,
    "sync-accepted",
    sync.status === 200 && Array.isArray(sync.body?.acceptedIds) &&
      (sync.body?.acceptedIds as string[]).includes(detail.id),
    `sync → ${sync.status}`,
  );
  releaseSet();
  // cacheSetFenced awaits its compensating DEL, so the parked caller only
  // answers once the undo gate opens; the in-window GET goes first.
  const undoReached = await Promise.race([
    undoParkedP.then(() => true),
    sleep(1_000).then(() => false),
  ]);
  note(
    ctx,
    "losing-set-undone-with-del",
    undoReached,
    `compensating DEL issued=${undoReached}`,
  );
  const todays = [todayStart, todayUtc()];
  const pre = expectedSet(ctx, user.actor.userId, user.precommitted, todays);
  const fresh = expectedSet(ctx, user.actor.userId, [
    ...user.precommitted,
    detail.id,
  ], todays);
  const inWindow = await finalGet(ctx, user, "get:in-undo-window");
  releaseUndo();
  const coldResult = await cold;
  ctx.results.push(coldResult);
  note(
    ctx,
    "parked-caller-body-admissible",
    bodiesMatch(coldResult.body, pre) || bodiesMatch(coldResult.body, fresh),
    "the parked build's own caller may see either snapshot",
  );
  await sleep(ctx.latencyMs * 2 + 2);
  const after = await finalGet(ctx, user, "get:after-undo");
  checkCommonHealth(ctx, new Set([200]));
  note(
    ctx,
    "get-in-undo-window-fresh",
    inWindow.status === 200 && bodiesMatch(inWindow.body, fresh),
    bodiesMatch(inWindow.body, pre)
      ? "served the PRE-SYNC payload (losing L2 row read before its compensating DEL)"
      : `status=${inWindow.status}`,
  );
  if (bodiesMatch(inWindow.body, pre)) {
    attribute(ctx, "get-in-undo-window-fresh", KNOWN_DEFECTS.l2UndoWindow);
  }
  note(
    ctx,
    "get-after-undo-fresh",
    after.status === 200 && bodiesMatch(after.body, fresh),
    bodiesMatch(after.body, pre)
      ? "still the PRE-SYNC payload after the undo landed (L1 read-through copy, ≤ 60s)"
      : `status=${after.status}`,
  );
  if (bodiesMatch(after.body, pre)) {
    attribute(ctx, "get-after-undo-fresh", KNOWN_DEFECTS.l2UndoWindow);
  }
  ctx.observations.l2RowAfter = h.redis.has(key) ? "present" : "absent";
}

/** cacheDel clears L1 and then sends INCR gen + DEL row; park that pipeline
 * on the wire. A GET issued meanwhile misses L1, reads the still-present L2
 * row and copies it into L1 — after the invalidation already ran. Shape:
 * warm GET → sync (DEL parked) → GET during the window → release → sync
 * returns → GET. */
async function l2ReadThroughRace(ctx: Ctx): Promise<void> {
  const { h, prng } = ctx;
  h.redisFault = () => null; // deterministic: only the wire delay below
  const user = await newUser(ctx, 0, prng.int(1, 8));
  const key = `progress:${user.actor.userId}`;
  const todayStart = todayUtc();
  const warm = await finalGet(ctx, user, "get:warm");
  const pre = expectedSet(ctx, user.actor.userId, user.precommitted, [
    todayStart,
  ]);
  note(
    ctx,
    "warm-correct",
    warm.status === 200 && bodiesMatch(warm.body, pre) && h.redis.has(key),
    `status=${warm.status} l2=${h.redis.has(key)}`,
  );
  let releaseDel!: () => void;
  const delGate = new Promise<void>((resolve) => (releaseDel = resolve));
  let delParked!: () => void;
  const delParkedP = new Promise<void>((resolve) => (delParked = resolve));
  let dels = 0;
  h.redisHold = (commands) => {
    if (
      dels === 0 && pipelineHas(commands, "DEL", key) &&
      pipelineHas(commands, "INCR", `gen:${key}`)
    ) {
      dels += 1;
      delParked();
      return delGate;
    }
    return null;
  };
  const detail = randomShotDetail(prng, user.actor.userId, {
    lowConfidence: false,
  });
  h.details.set(detail.id, detail);
  user.newShots.set(detail.id, detail);
  const sync = timed(
    h,
    "sync",
    "sync:del-parked",
    syncRequest(user.actor, [
      wireShot(detail, reservePermit(h, prng, user.actor.userId)),
    ]),
  );
  const reached = await Promise.race([
    delParkedP.then(() => true),
    sleep(3_000).then(() => false),
  ]);
  note(ctx, "invalidation-del-reached", reached, `dels=${dels}`);
  // Concurrent with the sync: the reader may see either snapshot…
  const during = await finalGet(ctx, user, "get:during-invalidation");
  releaseDel();
  const syncResult = await sync;
  ctx.results.push(syncResult);
  user.deliveries.push({ result: syncResult, shotIds: [detail.id] });
  note(
    ctx,
    "sync-accepted",
    syncResult.status === 200 &&
      Array.isArray(syncResult.body?.acceptedIds) &&
      (syncResult.body?.acceptedIds as string[]).includes(detail.id),
    `sync → ${syncResult.status}`,
  );
  const todays = [todayStart, todayUtc()];
  const preNow = expectedSet(ctx, user.actor.userId, user.precommitted, todays);
  const fresh = expectedSet(ctx, user.actor.userId, [
    ...user.precommitted,
    detail.id,
  ], todays);
  note(
    ctx,
    "during-body-admissible",
    bodiesMatch(during.body, preNow) || bodiesMatch(during.body, fresh),
    "a GET concurrent with the sync may see either snapshot",
  );
  // …but once the sync has returned, read-your-writes must hold.
  const burst = prng.int(1, 4);
  ctx.scale.burst = burst;
  const after = await schedule(
    Array.from({ length: burst }, (_, i) => ({
      at: prng.int(0, ctx.latencyMs),
      run: () =>
        timed(h, "get", `get:after-sync#${i}`, progressRequest(user.actor)),
    })),
  );
  ctx.results.push(...after);
  checkCommonHealth(ctx, new Set([200]));
  const stale = after.filter((r) => bodiesMatch(r.body, preNow));
  const allFresh = after.every((r) =>
    r.status === 200 && bodiesMatch(r.body, fresh)
  );
  const races = readThroughRaces(ctx, user.actor.userId);
  ctx.observations.readThroughRaces = races;
  ctx.observations.l2RowAfter = h.redis.has(key) ? "present" : "absent";
  note(
    ctx,
    "post-sync-gets-fresh",
    allFresh,
    `${
      after.length - stale.length
    }/${after.length} fresh, ${stale.length} served the PRE-SYNC payload (L2 row read through into L1 while its DEL was in flight; L2 row now ${
      h.redis.has(key) ? "present" : "absent"
    })`,
  );
  if (
    !allFresh && races.length > 0 &&
    after.every((r) =>
      r.status === 200 && (bodiesMatch(r.body, fresh) || stale.includes(r))
    )
  ) {
    attribute(ctx, "post-sync-gets-fresh", KNOWN_DEFECTS.l2ReadThroughRace);
  }
}

/** Deterministic coalesce gap. GET A (cold) has its cacheFence read failed,
 * so its build lands in L1 only; GET B's L2 read is parked until A has
 * answered, then misses. B finds no build in flight and rebuilds. Shape:
 * GET A ‖ GET B (L2 read parked) → A done → release → GET C. */
async function l2CoalesceGap(ctx: Ctx): Promise<void> {
  const { h, prng } = ctx;
  const user = await newUser(ctx, 0, prng.int(0, 8));
  const key = `progress:${user.actor.userId}`;
  const todayStart = todayUtc();
  let fenceFaults = 0;
  h.redisFault = (commands) => {
    if (fenceFaults === 0 && pipelineHas(commands, "GET", `gen:${key}`)) {
      fenceFaults += 1;
      return prng.next() < 0.5 ? "http500" : "throw";
    }
    return null;
  };
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
  let readParked!: () => void;
  const readParkedP = new Promise<void>((resolve) => (readParked = resolve));
  let l2Reads = 0;
  h.redisHold = (commands) => {
    const isRowRead = pipelineHas(commands, "GET", key) &&
      !commands.some((c) => String(c[0]).toUpperCase() === "SET");
    if (!isRowRead) return null;
    l2Reads += 1;
    if (l2Reads === 2) {
      readParked();
      return readGate;
    }
    return null;
  };
  const a = timed(h, "get", "get:A", progressRequest(user.actor));
  const b = timed(h, "get", "get:B", progressRequest(user.actor));
  const parked = await Promise.race([
    readParkedP.then(() => true),
    sleep(3_000).then(() => false),
  ]);
  note(ctx, "second-l2-read-parked", parked, `l2Reads=${l2Reads}`);
  // Whichever request was not parked builds and answers first.
  await Promise.race([a, b]);
  note(
    ctx,
    "fence-read-was-failed",
    fenceFaults === 1,
    `fence GETs failed=${fenceFaults}`,
  );
  const buildsAfterA = h.reads.progress_daily;
  releaseRead();
  const [aResult, bResult] = await Promise.all([a, b]);
  const cResult = await timed(h, "get", "get:C", progressRequest(user.actor));
  ctx.results.push(aResult, bResult, cResult);
  user.gets.push(aResult, bResult, cResult);
  checkCommonHealth(ctx, new Set([200]));
  const expected = expectedSet(ctx, user.actor.userId, user.precommitted, [
    todayStart,
    todayUtc(),
  ]);
  note(
    ctx,
    "all-bodies-correct",
    [aResult, bResult, cResult].every((r) =>
      r.status === 200 && bodiesMatch(r.body, expected)
    ),
    "every GET returns the committed state (no staleness, only extra work)",
  );
  const gaps = coalesceGaps(ctx, user.actor.userId);
  ctx.observations.coalesceGaps = gaps;
  ctx.observations.buildsAfterA = buildsAfterA;
  note(
    ctx,
    "concurrent-gets-share-one-build",
    h.reads.progress_daily === 1,
    `builds=${h.reads.progress_daily} (A built, B rebuilt instead of serving A's L1 row)${
      gaps.length ? `; ${gaps.join("; ")}` : ""
    }`,
  );
  if (
    h.reads.progress_daily > 1 && buildsAfterA === 1 &&
    onlyCoalesceGaps(ctx, user.actor.userId)
  ) {
    attribute(
      ctx,
      "concurrent-gets-share-one-build",
      KNOWN_DEFECTS.coalesceGap,
    );
  }
}

const SHOT_TYPE_POOL = [
  "dink",
  "drive",
  "third_shot_drop",
  "serve",
  "volley",
  "lob",
  "overhead",
  "reset",
];
const VERSION_POOL = ["scoring-1", "scoring-2", "scoring-3"];

// ── Campaign runner ──────────────────────────────────────────────────────────

function mixSeed(seed: number, family: string): number {
  let x = seed >>> 0;
  for (let i = 0; i < family.length; i += 1) {
    x = Math.imul(x ^ family.charCodeAt(i), 0x01000193) >>> 0;
  }
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  return x >>> 0;
}

export async function runIteration(
  h: StressHarness,
  family: Family,
  seed: number,
  latencyMs: number,
  replay: string,
  redisFaultRate = 0,
): Promise<IterationRow> {
  // Mix the family into the stream so the same seed under two families never
  // shares actors (the production module's L1 outlives an iteration).
  const stream = mixSeed(seed, family);
  h.resetIteration(stream, latencyMs);
  if (redisFaultRate > 0) {
    const faultPrng = new Prng((stream ^ 0x27d4eb2f) >>> 0);
    h.redisFault = () => {
      if (faultPrng.next() >= redisFaultRate) return null;
      return faultPrng.next() < 0.5 ? "http500" : "throw";
    };
  }
  const ctx: Ctx = {
    h,
    prng: new Prng(stream),
    seed,
    latencyMs,
    invariants: [],
    results: [],
    observations: {},
    scale: {},
    attributed: new Map(),
  };
  const t0 = performance.now();
  try {
    switch (family) {
      case "burst-cold":
        await burstCold(ctx);
        break;
      case "read-write-race":
        await readWriteRace(ctx, 1);
        break;
      case "multi-user":
        await readWriteRace(ctx, ctx.prng.int(2, 4));
        break;
      case "invalidation-gate":
        await invalidationGate(ctx);
        break;
      case "logout-rotation":
        await logoutRotation(ctx);
        break;
      case "clock-skew":
        await clockSkew(ctx);
        break;
      case "db-fault":
        await dbFault(ctx);
        break;
      case "paging-torn":
        await pagingTorn(ctx);
        break;
      case "l2-del-fault":
        await l2DelFault(ctx);
        break;
      case "l2-undo-window":
        await l2UndoWindow(ctx);
        break;
      case "l2-readthrough-race":
        await l2ReadThroughRace(ctx);
        break;
      case "l2-coalesce-gap":
        await l2CoalesceGap(ctx);
        break;
    }
  } catch (error) {
    note(
      ctx,
      "no-exception",
      false,
      String(error instanceof Error ? error.stack ?? error.message : error),
    );
  } finally {
    if (clockOffset() !== 0) setClockOffset(0);
    h.faults = {};
    h.redisHold = () => null;
    h.redisFault = () => null;
  }
  const histogram: Record<string, number> = {};
  for (const r of ctx.results) {
    const key = `${r.kind}:${r.timedOut ? "timeout" : r.status}`;
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  ctx.scale.requests = ctx.results.length;
  const broken = ctx.invariants.filter((i) => !i.holds);
  if (broken.length && h.redisFaultLog.length) {
    ctx.observations.redisFaultLog = h.redisFaultLog.map((f) =>
      `${Math.round(f.t)}: ${f.commands.join("; ")}`
    );
  }
  const defects = new Set<string>();
  let allAttributed = broken.length > 0;
  for (const i of broken) {
    const d = ctx.attributed.get(i.name);
    if (d) defects.add(d);
    else allAttributed = false;
  }
  return {
    seed,
    family,
    outcome: broken.length ? "BROKEN" : "HELD",
    ...(allAttributed ? { knownDefect: [...defects].sort().join("+") } : {}),
    scale: ctx.scale,
    statusHistogram: histogram,
    invariants: ctx.invariants,
    observations: {
      ...ctx.observations,
      upstreamCalls: h.upstreamCalls.length,
      redisPipelines: h.redisPipelines,
      redisFaults: h.redisFaults,
    },
    durationMs: Math.round((performance.now() - t0) * 100) / 100,
    replay,
  };
}

export async function runCampaign(options: {
  suite: string;
  file: string;
  redis: boolean;
  /** Probability that a fake Upstash pipeline call fails (redis only). */
  redisFaultRate?: number;
  extraEnv?: string;
}): Promise<CampaignReport> {
  const iterations = envInt("STRESS_ITER", 96);
  const seedBase = envInt("STRESS_SEED", 20260904);
  const latencyMs = envInt("STRESS_LATENCY_MS", 4);
  const redisFaultRate = options.redis ? options.redisFaultRate ?? 0 : 0;
  const families = familiesFor(options.redis);
  const only = Deno.env.get("STRESS_FAMILY") ?? "";
  if (only && !(families as readonly string[]).includes(only)) {
    throw new Error(`STRESS_FAMILY must be one of ${families.join(", ")}`);
  }
  const h = await loadStressHarness({ redis: options.redis });
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const rows: IterationRow[] = [];
  const familyCounts: Record<string, number> = {};
  for (let i = 0; i < iterations; i += 1) {
    const family = (only || families[i % families.length]) as Family;
    const seed = seedBase + i;
    const replay =
      `STRESS_SEED=${seed} STRESS_ITER=1 STRESS_FAMILY=${family} STRESS_LATENCY_MS=${latencyMs} ${
        options.extraEnv ?? ""
      }deno test -A --no-check --config deno.json ${options.file}`;
    const row = await runIteration(
      h,
      family,
      seed,
      latencyMs,
      replay,
      redisFaultRate,
    );
    rows.push(row);
    familyCounts[family] = (familyCounts[family] ?? 0) + 1;
  }
  const failing = rows
    .filter((r) => r.outcome === "BROKEN")
    .map((r) => ({
      seed: r.seed,
      family: r.family,
      invariants: r.invariants.filter((i) => !i.holds).map((i) =>
        `${i.name}: ${i.detail}`
      ),
      ...(r.knownDefect ? { knownDefect: r.knownDefect } : {}),
    }));
  const knownDefectSeeds: Record<string, number[]> = {};
  for (const r of rows) {
    if (!r.knownDefect) continue;
    (knownDefectSeeds[r.knownDefect] ??= []).push(r.seed);
  }
  const report: CampaignReport = {
    suite: options.suite,
    redis: options.redis,
    redisFaultRate,
    seedBase,
    iterations,
    latencyMs,
    startedAt,
    durationMs: Math.round(performance.now() - t0),
    scenariosExecuted: rows.length,
    requestsExecuted: rows.reduce((n, r) => n + (r.scale.requests ?? 0), 0),
    held: rows.length - failing.length,
    broken: failing.length,
    brokenKnown: failing.filter((f) => f.knownDefect).length,
    brokenUnknown: failing.filter((f) => !f.knownDefect).length,
    knownDefectSeeds,
    failingSeeds: failing,
    familyCounts,
    rows,
  };
  const path = await writeCampaign(options.suite, report);
  console.log(
    `[${options.suite}] ${report.held} HELD / ${report.broken} BROKEN (${report.brokenKnown} known-defect, ${report.brokenUnknown} unexplained) over ${report.scenariosExecuted} iterations (${report.requestsExecuted} requests, ${report.durationMs}ms) → ${path}`,
  );
  return report;
}
