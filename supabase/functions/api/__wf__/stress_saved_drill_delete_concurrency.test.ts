/**
 * stress — DELETE /v1/me/saved-drills/:slug — CONCURRENCY lens.
 *
 * Every test below runs STRESS_ITER seeded iterations (default 12; the
 * campaign that produced the evidence used STRESS_ITER=80 → 8 × 80 = 640
 * interleavings). Each iteration is one Promise.all burst against the REAL
 * handler whose upstream calls are released one at a time by a seeded
 * deterministic scheduler (see stress_saved_drill_delete_harness.ts), so a
 * failing iteration replays from its seed with the printed command.
 *
 * Scenarios:
 *   S1 dup-delete        N identical DELETEs of one bookmark → all 204, row
 *                        gone, sibling bookmarks intact, N upstream DELETEs.
 *   S2 put-delete-race   PUT and DELETE of the SAME slug interleaved → no
 *                        duplicate row, final state = last applied effect,
 *                        DELETE always 204; PUT outcome recorded.
 *   S3 two-actors        two users, same slug → RLS: A's deletes never touch
 *                        B's row; B's concurrent PUT/DELETE of the same slug
 *                        is independent.
 *   S4 logout-during     POST /v1/auth/logout racing DELETEs on the same
 *                        session → only 204/401, a request that STARTS after
 *                        the logout completed never reaches PostgREST.
 *   S5 rotation-during   POST /v1/auth/refresh mid-burst → old and new
 *                        access tokens both delete; no 401/5xx.
 *   S6 clock-skew        edge clock skewed vs the token issuer → an expired
 *                        bearer is refused before PostgREST; otherwise 204.
 *   S7 cancel/fault      client aborts + PostgREST network errors / 5xx →
 *                        503 (never 500), row deleted iff a DELETE applied,
 *                        a retry converges to 204 + absent.
 *   S8 rate-limit        one user, burst > GENERAL_USER_LIMIT → exactly the
 *                        budget succeeds, the rest 429 with Retry-After, no
 *                        lost or double-counted hit (atomic counter).
 *
 * Wall time: each burst must finish within STRESS_ITER_DEADLINE_MS (20s) or
 * the iteration is ERROR (deadlock / hung upstream).
 *
 * Replay one iteration:
 *   STRESS_ONLY_SEED=<seed> deno test -A --no-check --config deno.json \
 *     stress_saved_drill_delete_concurrency.test.ts --filter "<scenario>"
 */
import { assert, assertEquals } from "@std/assert";
import {
  callEdge,
  clock,
  edgeRequest,
  inv,
  type Invariant,
  type IterationContext,
  type IterationOutcome,
  type RequestRow,
  runScenario,
  type ScenarioReport,
  STRESS_ITER,
  STRESS_MAX_BURST,
  STRESS_SEED,
  writeJson,
} from "./stress_saved_drill_delete_harness.ts";
import { jwtPayload } from "./xc_concurrency_harness.ts";

const FILE = "stress_saved_drill_delete_concurrency.test.ts";
const SLUGS = [
  "third-shot-drop",
  "dink-crosscourt",
  "reset-from-transition",
  "serve-deep-target",
  "return-and-approach",
  "speed-up-counter",
];
/** GENERAL_USER_LIMIT in ../index.ts: 240 requests / 60s per user. */
const GENERAL_USER_LIMIT = 240;

const reports: ScenarioReport[] = [];

function burstSize(ctx: IterationContext, min = 4): number {
  return ctx.prng.int(min, Math.max(min, STRESS_MAX_BURST));
}

function del(ctx: IterationContext, lane: number, bearer: string, slug: string, ip = ctx.ip) {
  return () =>
    callEdge(
      ctx.harness,
      lane,
      `DELETE ${slug}`,
      edgeRequest("DELETE", `/v1/me/saved-drills/${encodeURIComponent(slug)}`, { bearer, ip }),
      ctx.t0,
    );
}

function put(ctx: IterationContext, lane: number, bearer: string, slug: string) {
  return () =>
    callEdge(
      ctx.harness,
      lane,
      `PUT ${slug}`,
      edgeRequest("PUT", `/v1/me/saved-drills/${encodeURIComponent(slug)}`, {
        bearer,
        ip: ctx.ip,
        body: { slug, saved: true },
      }),
      ctx.t0,
    );
}

function list(ctx: IterationContext, lane: number, bearer: string) {
  return () =>
    callEdge(
      ctx.harness,
      lane,
      "GET list",
      edgeRequest("GET", "/v1/me/saved-drills", { bearer, ip: ctx.ip }),
      ctx.t0,
    );
}

async function listSlugs(ctx: IterationContext, bearer: string): Promise<string[]> {
  const response = await ctx.one(async () => {
    const res = await ctx.harness.handler(
      edgeRequest("GET", "/v1/me/saved-drills", { bearer, ip: ctx.ip }),
    );
    const body = (await res.json()) as { items?: Array<{ slug: string }> };
    return {
      lane: -1,
      op: "GET list",
      status: res.status,
      code: null,
      startedAt: 0,
      endedAt: 0,
      note: JSON.stringify((body.items ?? []).map((i) => i.slug)),
    };
  });
  assertEquals(response.status, 200, "GET /v1/me/saved-drills must answer 200");
  return JSON.parse(response.note ?? "[]") as string[];
}

const statuses = (rows: RequestRow[], op: (o: string) => boolean) =>
  rows.filter((r) => op(r.op)).map((r) => r.status);
const all = (values: number[], want: number) => values.every((v) => v === want);
const no5xx = (rows: RequestRow[]): Invariant =>
  inv(
    "no_5xx",
    rows.every((r) => r.status < 500),
    `statuses ${JSON.stringify(rows.map((r) => r.status))}`,
  );
const noDuplicateRows = (ctx: IterationContext): Invariant =>
  inv(
    "no_duplicate_rows",
    ctx.fake.duplicates().length === 0,
    `duplicates ${JSON.stringify(ctx.fake.duplicates())}`,
  );

// ── S1 ───────────────────────────────────────────────────────────────────────

Deno.test(
  "stress s1-dup-delete: N identical DELETEs of one bookmark are all 204, row gone, siblings intact",
  async () => {
    const report = await runScenario(
      FILE,
      "s1-dup-delete",
      "duplicate DELETE burst, same user, same slug",
      async (ctx): Promise<IterationOutcome> => {
        const user = ctx.fake.newUser();
        const session = ctx.fake.mintSession(user);
        const target = SLUGS[ctx.prng.int(0, SLUGS.length - 1)];
        const siblings = SLUGS.filter((s) => s !== target).slice(0, ctx.prng.int(0, 3));
        ctx.fake.save(user, target);
        for (const s of siblings) ctx.fake.save(user, s);
        const n = burstSize(ctx);

        const rows = await ctx.burst(
          Array.from({ length: n }, (_, lane) => del(ctx, lane, session.accessToken, target)),
        );
        const after = await listSlugs(ctx, session.accessToken);

        const invariants: Invariant[] = [
          inv(
            "all_204",
            all(
              rows.map((r) => r.status),
              204,
            ),
            `statuses ${JSON.stringify(rows.map((r) => r.status))}`,
          ),
          inv(
            "row_deleted",
            !ctx.fake.has(user, target),
            `has(${target})=${ctx.fake.has(user, target)}`,
          ),
          inv(
            "siblings_intact",
            siblings.every((s) => ctx.fake.has(user, s)),
            `siblings ${JSON.stringify(siblings)} present=${JSON.stringify(siblings.map((s) => ctx.fake.has(user, s)))}`,
          ),
          inv(
            "list_agrees",
            after.length === siblings.length && siblings.every((s) => after.includes(s)),
            `GET list → ${JSON.stringify(after)}`,
          ),
          inv(
            "every_call_reached_postgrest",
            ctx.fake.counters["rest.delete"] === n,
            `rest.delete=${ctx.fake.counters["rest.delete"]} expected ${n}`,
          ),
          inv(
            "exactly_one_row_removed",
            ctx.fake.counters["rest.delete.removed"] === 1,
            `removed=${ctx.fake.counters["rest.delete.removed"]} noop=${ctx.fake.counters["rest.delete.noop"] ?? 0}`,
          ),
          noDuplicateRows(ctx),
          no5xx(rows),
        ];
        return {
          burst: n,
          inputs: { user, target, siblings },
          requests: rows,
          invariants,
          observations: {
            getUserCalls: ctx.fake.counters["gotrue.get_user"] ?? 0,
            noopDeletes: ctx.fake.counters["rest.delete.noop"] ?? 0,
          },
        };
      },
    );
    reports.push(report);
    assertEquals(report.broken + report.errored, 0, `S1 failing seeds: ${failingSeeds(report)}`);
  },
);

// ── S2 ───────────────────────────────────────────────────────────────────────

Deno.test(
  "stress s2-put-delete-race: PUT and DELETE of the same slug interleave without duplicate rows or lost updates",
  async () => {
    const report = await runScenario(
      FILE,
      "s2-put-delete-race",
      "PUT/DELETE of the same (user, slug) interleaved",
      async (ctx): Promise<IterationOutcome> => {
        const user = ctx.fake.newUser();
        const session = ctx.fake.mintSession(user);
        const target = SLUGS[ctx.prng.int(0, SLUGS.length - 1)];
        const initiallySaved = ctx.prng.next() < 0.5;
        if (initiallySaved) ctx.fake.save(user, target);
        const n = burstSize(ctx);
        const ops = Array.from({ length: n }, () => (ctx.prng.next() < 0.5 ? "PUT" : "DELETE"));

        const rows = await ctx.burst(
          ops.map((op, lane) =>
            op === "PUT"
              ? put(ctx, lane, session.accessToken, target)
              : del(ctx, lane, session.accessToken, target),
          ),
        );
        const after = await listSlugs(ctx, session.accessToken);

        // Linearization from the fake's applied effects: the last effect that
        // touched the row decides the final state.
        const touching = ctx.fake.effects.filter(
          (e) =>
            (e.startsWith("upsert") && e.includes(`/${target} `)) ||
            (e.startsWith("delete#") && e.includes(`slug=eq.${target}`)),
        );
        const last = touching[touching.length - 1] ?? null;
        // last upsert (inserted or duplicate) → present; last delete (1 or 0
        // rows: a 0-row delete means it was already absent) → absent.
        const expectPresent = last === null ? initiallySaved : last.startsWith("upsert");
        const present = ctx.fake.has(user, target);
        const deleteStatuses = statuses(rows, (o) => o.startsWith("DELETE"));
        const putStatuses = statuses(rows, (o) => o.startsWith("PUT"));
        const put503 = putStatuses.filter((s) => s === 503).length;

        const invariants: Invariant[] = [
          inv(
            "delete_all_204",
            all(deleteStatuses, 204),
            `DELETE statuses ${JSON.stringify(deleteStatuses)}`,
          ),
          inv(
            "put_200_or_503",
            putStatuses.every((s) => s === 200 || s === 503),
            `PUT statuses ${JSON.stringify(putStatuses)}`,
          ),
          noDuplicateRows(ctx),
          inv(
            "final_state_matches_last_effect",
            present === expectPresent,
            `last effect "${last}" present=${present}`,
          ),
          inv(
            "list_agrees_with_table",
            after.includes(target) === present,
            `GET list has ${target}: ${after.includes(target)}, table: ${present}`,
          ),
          inv(
            "no_500",
            rows.every((r) => r.status !== 500),
            `statuses ${JSON.stringify(rows.map((r) => r.status))}`,
          ),
          inv(
            "bounded_upstream_calls",
            (ctx.fake.counters["rest.delete"] ?? 0) === ops.filter((o) => o === "DELETE").length &&
              (ctx.fake.counters["rest.upsert"] ?? 0) === ops.filter((o) => o === "PUT").length,
            `rest.delete=${ctx.fake.counters["rest.delete"] ?? 0} rest.upsert=${ctx.fake.counters["rest.upsert"] ?? 0} ops=${JSON.stringify(ops)}`,
          ),
        ];
        return {
          burst: n,
          inputs: { user, target, initiallySaved, ops },
          requests: rows,
          invariants,
          observations: {
            put503,
            putOk: putStatuses.filter((s) => s === 200).length,
            finalPresent: present,
          },
        };
      },
    );
    reports.push(report);
    const put503Iterations = report.iterations.filter(
      (it) => Number(it.observations.put503 ?? 0) > 0,
    );
    console.log(
      `[stress] s2 observation: PUT answered 503 in ${put503Iterations.length}/${report.executed} iterations (seeds ${JSON.stringify(put503Iterations.map((it) => it.seed).slice(0, 10))})`,
    );
    assertEquals(report.broken + report.errored, 0, `S2 failing seeds: ${failingSeeds(report)}`);
  },
);

// ── S3 ───────────────────────────────────────────────────────────────────────

Deno.test(
  "stress s3-two-actors: user A's DELETE burst never touches user B's identical slug",
  async () => {
    const report = await runScenario(
      FILE,
      "s3-two-actors",
      "two users, same slug, concurrent DELETE / PUT / DELETE",
      async (ctx): Promise<IterationOutcome> => {
        const a = ctx.fake.newUser("apple");
        const b = ctx.fake.newUser("google");
        const sa = ctx.fake.mintSession(a);
        const sb = ctx.fake.mintSession(b);
        const target = SLUGS[ctx.prng.int(0, SLUGS.length - 1)];
        const other = SLUGS.find((s) => s !== target)!;
        ctx.fake.save(a, target);
        ctx.fake.save(b, target);
        ctx.fake.save(b, other);
        const nA = burstSize(ctx, 2);
        const bOps = Array.from({ length: ctx.prng.int(1, 6) }, () => {
          const r = ctx.prng.next();
          return r < 0.5 ? "PUT target" : r < 0.8 ? "DELETE other" : "GET list";
        });
        const tasks = [
          ...Array.from({ length: nA }, (_, lane) =>
            del(ctx, lane, sa.accessToken, target, `${ctx.ip}`),
          ),
          ...bOps.map((op, i) => {
            const lane = nA + i;
            if (op === "PUT target") return put(ctx, lane, sb.accessToken, target);
            if (op === "DELETE other") return del(ctx, lane, sb.accessToken, other);
            return list(ctx, lane, sb.accessToken);
          }),
        ];
        const rows = await ctx.burst(ctx.prng.shuffle(tasks));
        const bList = await listSlugs(ctx, sb.accessToken);
        const aList = await listSlugs(ctx, sa.accessToken);
        const bDeletedOther = bOps.includes("DELETE other");

        const invariants: Invariant[] = [
          inv(
            "a_deletes_all_204",
            all(
              rows.filter((r) => r.lane < nA).map((r) => r.status),
              204,
            ),
            `A statuses ${JSON.stringify(rows.filter((r) => r.lane < nA).map((r) => r.status))}`,
          ),
          inv(
            "a_row_deleted",
            !ctx.fake.has(a, target),
            `A has ${target}: ${ctx.fake.has(a, target)}`,
          ),
          inv(
            "b_row_survives",
            ctx.fake.has(b, target),
            `B has ${target}: ${ctx.fake.has(b, target)}`,
          ),
          inv(
            "b_other_slug_consistent",
            ctx.fake.has(b, other) === !bDeletedOther,
            `B has ${other}: ${ctx.fake.has(b, other)}; B deleted it: ${bDeletedOther}`,
          ),
          inv("b_list_has_target", bList.includes(target), `B list ${JSON.stringify(bList)}`),
          inv("a_list_lacks_target", !aList.includes(target), `A list ${JSON.stringify(aList)}`),
          inv(
            "only_one_row_removed_for_target",
            (ctx.fake.counters["rest.delete.removed"] ?? 0) === 1 + (bDeletedOther ? 1 : 0),
            `removed=${ctx.fake.counters["rest.delete.removed"] ?? 0}`,
          ),
          noDuplicateRows(ctx),
          no5xx(rows),
        ];
        return {
          burst: tasks.length,
          inputs: { a, b, target, other, nA, bOps },
          requests: rows,
          invariants,
          observations: { bList, aList },
        };
      },
    );
    reports.push(report);
    assertEquals(report.broken + report.errored, 0, `S3 failing seeds: ${failingSeeds(report)}`);
  },
);

// ── S4 ───────────────────────────────────────────────────────────────────────

Deno.test(
  "stress s4-logout-during-delete: a DELETE racing POST /v1/auth/logout is 204 or 401, never 5xx; nothing authenticates after the logout completed",
  async () => {
    const report = await runScenario(
      FILE,
      "s4-logout-during-delete",
      "logout of the same session racing a DELETE burst",
      async (ctx): Promise<IterationOutcome> => {
        const user = ctx.fake.newUser();
        const session = ctx.fake.mintSession(user);
        const target = SLUGS[ctx.prng.int(0, SLUGS.length - 1)];
        const other = SLUGS.find((s) => s !== target)!;
        ctx.fake.save(user, target);
        ctx.fake.save(user, other);
        // Optionally warm the auth cache so the burst mixes cache hits and
        // verifications racing the logout.
        const warm = ctx.prng.next() < 0.5;
        if (warm) {
          const w = await ctx.one(list(ctx, -1, session.accessToken));
          assertEquals(w.status, 200);
        }
        const n = burstSize(ctx, 3);
        const logoutLane = ctx.prng.int(0, n - 1);
        const tasks = Array.from({ length: n }, (_, lane) =>
          lane === logoutLane
            ? () =>
                callEdge(
                  ctx.harness,
                  lane,
                  "POST logout",
                  edgeRequest("POST", "/v1/auth/logout", {
                    bearer: session.accessToken,
                    ip: ctx.ip,
                  }),
                  ctx.t0,
                )
            : del(ctx, lane, session.accessToken, lane % 3 === 0 ? other : target),
        );
        const rows = await ctx.burst(tasks);
        const logout = rows[logoutLane];
        // Requests issued strictly after the logout completed must be refused
        // without reaching PostgREST.
        const deletesBefore = ctx.fake.counters["rest.delete"] ?? 0;
        const postRows = await ctx.burst(
          Array.from({ length: ctx.prng.int(1, 4) }, (_, i) =>
            del(ctx, n + i, session.accessToken, target),
          ),
        );
        const deletesAfter = ctx.fake.counters["rest.delete"] ?? 0;
        const deleteRows = rows.filter((r) => r.op.startsWith("DELETE"));

        const invariants: Invariant[] = [
          inv("logout_204", logout.status === 204, `logout status ${logout.status}`),
          inv(
            "deletes_204_or_401",
            deleteRows.every((r) => r.status === 204 || r.status === 401),
            `DELETE statuses ${JSON.stringify(deleteRows.map((r) => r.status))}`,
          ),
          inv(
            "after_logout_all_401",
            postRows.every((r) => r.status === 401),
            `post-logout statuses ${JSON.stringify(postRows.map((r) => r.status))}`,
          ),
          inv(
            "after_logout_no_postgrest",
            deletesAfter === deletesBefore,
            `rest.delete before=${deletesBefore} after=${deletesAfter}`,
          ),
          inv(
            "no_row_survives_a_204",
            deleteRows.filter((r) => r.status === 204 && r.op === `DELETE ${target}`).length ===
              0 || !ctx.fake.has(user, target),
            `204s for ${target}: ${deleteRows.filter((r) => r.status === 204 && r.op === `DELETE ${target}`).length}, present=${ctx.fake.has(user, target)}`,
          ),
          inv(
            "401_means_no_effect",
            // a 401 never counts as a delete: the number of applied deletes equals the number of 204s
            (ctx.fake.counters["rest.delete"] ?? 0) ===
              deleteRows.filter((r) => r.status === 204).length,
            `rest.delete=${ctx.fake.counters["rest.delete"] ?? 0} 204s=${deleteRows.filter((r) => r.status === 204).length}`,
          ),
          no5xx([...rows, ...postRows]),
        ];
        const schedule = ctx.sched.steps;
        const logoutStep = schedule.findIndex(
          (s) => s.startsWith("gotrue.logout") && s.endsWith(".arrive"),
        );
        const deletesAfterLogoutEffect = schedule.filter(
          (s, i) => i > logoutStep && s.startsWith("rest.delete") && s.endsWith(".arrive"),
        ).length;
        return {
          burst: n,
          inputs: { user, target, other, warm, logoutLane, sessionId: session.sessionId },
          requests: [...rows, ...postRows],
          invariants,
          observations: {
            deletes204: deleteRows.filter((r) => r.status === 204).length,
            deletes401: deleteRows.filter((r) => r.status === 401).length,
            // TOCTOU window: DELETEs that reached PostgREST after GoTrue had
            // already revoked the session (authenticated before the logout).
            postgrestDeletesAfterRevocation: logoutStep >= 0 ? deletesAfterLogoutEffect : null,
            getUserRefused: ctx.fake.counters["gotrue.get_user.refused"] ?? 0,
          },
        };
      },
    );
    reports.push(report);
    const toctou = report.iterations.filter(
      (it) => Number(it.observations.postgrestDeletesAfterRevocation ?? 0) > 0,
    );
    console.log(
      `[stress] s4 observation: in ${toctou.length}/${report.executed} iterations a DELETE authenticated before the logout reached PostgREST after GoTrue revoked the session (same user, own bookmark)`,
    );
    assertEquals(report.broken + report.errored, 0, `S4 failing seeds: ${failingSeeds(report)}`);
  },
);

// ── S5 ───────────────────────────────────────────────────────────────────────

Deno.test(
  "stress s5-rotation-during-delete: POST /v1/auth/refresh mid-burst leaves old and new bearers deleting (204), no 401/5xx",
  async () => {
    const report = await runScenario(
      FILE,
      "s5-rotation-during-delete",
      "session refresh racing a DELETE burst; new bearer used afterwards",
      async (ctx): Promise<IterationOutcome> => {
        const user = ctx.fake.newUser();
        const session = ctx.fake.mintSession(user);
        const oldAccess = session.accessToken;
        const refreshToken = session.refreshToken;
        const targets = ctx.prng.shuffle(SLUGS).slice(0, ctx.prng.int(2, 4));
        for (const s of targets) ctx.fake.save(user, s);
        const n = burstSize(ctx, 3);
        const refreshLane = ctx.prng.int(0, n - 1);
        const tasks = Array.from({ length: n }, (_, lane) =>
          lane === refreshLane
            ? () =>
                callEdge(
                  ctx.harness,
                  lane,
                  "POST refresh",
                  edgeRequest("POST", "/v1/auth/refresh", { ip: ctx.ip, body: { refreshToken } }),
                  ctx.t0,
                )
            : del(ctx, lane, oldAccess, targets[0]),
        );
        const rows = await ctx.burst(tasks);
        const refresh = rows[refreshLane];
        const newAccess = ctx.fake.sessions.get(session.sessionId)!.accessToken;
        const rotated = newAccess !== oldAccess;
        const phase2 = await ctx.burst([
          ...targets.slice(1).map((s, i) => del(ctx, n + i, newAccess, s)),
          del(ctx, n + targets.length, oldAccess, targets[0]),
        ]);
        const after = await listSlugs(ctx, newAccess);
        const allDeletes = [...rows.filter((r) => r.op.startsWith("DELETE")), ...phase2];

        const invariants: Invariant[] = [
          inv("refresh_200", refresh.status === 200, `refresh status ${refresh.status}`),
          inv("session_rotated", rotated, `rotated=${rotated}`),
          inv(
            "all_deletes_204",
            all(
              allDeletes.map((r) => r.status),
              204,
            ),
            `statuses ${JSON.stringify(allDeletes.map((r) => r.status))}`,
          ),
          inv(
            "all_targets_deleted",
            targets.every((s) => !ctx.fake.has(user, s)),
            `remaining ${JSON.stringify(ctx.fake.rows.filter((r) => r.user_id === user).map((r) => r.slug))}`,
          ),
          inv("list_empty", after.length === 0, `GET list → ${JSON.stringify(after)}`),
          inv(
            "removed_once_per_target",
            (ctx.fake.counters["rest.delete.removed"] ?? 0) === targets.length,
            `removed=${ctx.fake.counters["rest.delete.removed"] ?? 0} targets=${targets.length}`,
          ),
          noDuplicateRows(ctx),
          no5xx([...rows, ...phase2]),
        ];
        return {
          burst: n + phase2.length,
          inputs: { user, targets, refreshLane, sessionId: session.sessionId },
          requests: [...rows, ...phase2],
          invariants,
          observations: { getUserCalls: ctx.fake.counters["gotrue.get_user"] ?? 0 },
        };
      },
    );
    reports.push(report);
    assertEquals(report.broken + report.errored, 0, `S5 failing seeds: ${failingSeeds(report)}`);
  },
);

// ── S6 ───────────────────────────────────────────────────────────────────────

Deno.test(
  "stress s6-clock-skew: an edge clock skewed against the token issuer refuses only genuinely expired bearers, before PostgREST",
  async () => {
    const SKEWS_S = [-7200, -61, -1, 0, 1, 59, 61, 3540, 3599, 3600, 3601, 7200];
    const report = await runScenario(
      FILE,
      "s6-clock-skew",
      "edge Date.now skewed by S seconds; token exp = issuer now + 3600",
      async (ctx): Promise<IterationOutcome> => {
        const user = ctx.fake.newUser();
        // Issuer clock = unskewed frozen now; token lives 3600s from it.
        const session = ctx.fake.mintSession(user, undefined, Math.floor(Date.now() / 1000) + 3600);
        const target = SLUGS[ctx.prng.int(0, SLUGS.length - 1)];
        const other = SLUGS.find((s) => s !== target)!;
        ctx.fake.save(user, target);
        ctx.fake.save(user, other);
        const skewS = SKEWS_S[ctx.prng.int(0, SKEWS_S.length - 1)];
        clock.skewMs = skewS * 1000;
        const expired = skewS >= 3600;
        const n = burstSize(ctx, 3);
        const rows = await ctx.burst(
          Array.from({ length: n }, (_, lane) => del(ctx, lane, session.accessToken, target)),
        );
        const wantStatus = expired ? 401 : 204;

        const invariants: Invariant[] = [
          inv(
            `all_${wantStatus}`,
            all(
              rows.map((r) => r.status),
              wantStatus,
            ),
            `skew=${skewS}s statuses ${JSON.stringify(rows.map((r) => r.status))}`,
          ),
          inv(
            "expired_bearer_never_reaches_upstream",
            !expired ||
              ((ctx.fake.counters["rest.delete"] ?? 0) === 0 &&
                (ctx.fake.counters["gotrue.get_user"] ?? 0) === 0),
            `rest.delete=${ctx.fake.counters["rest.delete"] ?? 0} get_user=${ctx.fake.counters["gotrue.get_user"] ?? 0}`,
          ),
          inv(
            "row_state",
            ctx.fake.has(user, target) === expired,
            `present=${ctx.fake.has(user, target)} expired=${expired}`,
          ),
          inv(
            "other_intact",
            ctx.fake.has(user, other),
            `other present=${ctx.fake.has(user, other)}`,
          ),
          inv(
            "no_postgrest_jwt_expired",
            (ctx.fake.counters["rest.jwt_expired"] ?? 0) === 0,
            `rest.jwt_expired=${ctx.fake.counters["rest.jwt_expired"] ?? 0}`,
          ),
          no5xx(rows),
        ];
        return {
          burst: n,
          inputs: { user, target, skewS, tokenExp: jwtPayload(session.accessToken)?.exp ?? null },
          requests: rows,
          invariants,
          observations: {
            getUserCalls: ctx.fake.counters["gotrue.get_user"] ?? 0,
            // remaining lifetime < 90s → the edge skips caching (ttl < 60s) and
            // verifies every request with GoTrue.
            cacheEligible: 3600 - skewS - 30 >= 60,
          },
        };
      },
    );
    reports.push(report);
    assertEquals(report.broken + report.errored, 0, `S6 failing seeds: ${failingSeeds(report)}`);
  },
);

// ── S7 ───────────────────────────────────────────────────────────────────────

Deno.test(
  "stress s7-cancel-and-faults: aborted clients and PostgREST failures yield 503 (never 500); a retry converges",
  async () => {
    const report = await runScenario(
      FILE,
      "s7-cancel-and-faults",
      "client aborts mid-flight; PostgREST DELETE throws / 5xx for a seeded subset",
      async (ctx): Promise<IterationOutcome> => {
        const user = ctx.fake.newUser();
        const session = ctx.fake.mintSession(user);
        const target = SLUGS[ctx.prng.int(0, SLUGS.length - 1)];
        const other = SLUGS.find((s) => s !== target)!;
        ctx.fake.save(user, target);
        ctx.fake.save(user, other);
        const n = burstSize(ctx, 3);
        const faultPlan: Array<"throw" | 500 | 502 | 503 | null> = Array.from({ length: n }, () => {
          const r = ctx.prng.next();
          if (r < 0.15) return "throw";
          if (r < 0.25) return 500;
          if (r < 0.3) return 502;
          if (r < 0.4) return 503;
          return null;
        });
        ctx.fake.faults.restDelete = (k) => faultPlan[k - 1] ?? null;
        const abortLanes = new Set(
          Array.from({ length: ctx.prng.int(0, Math.min(3, n)) }, () => ctx.prng.int(0, n - 1)),
        );
        const controllers = new Map<number, AbortController>();
        const tasks = Array.from({ length: n }, (_, lane) => {
          if (!abortLanes.has(lane)) return del(ctx, lane, session.accessToken, target);
          const controller = new AbortController();
          controllers.set(lane, controller);
          return async () => {
            const request = edgeRequest(
              "DELETE",
              `/v1/me/saved-drills/${encodeURIComponent(target)}`,
              {
                bearer: session.accessToken,
                ip: ctx.ip,
                signal: controller.signal,
              },
            );
            // The client gives up: it stops awaiting and aborts its signal.
            // The server-side handler has no body to read and completes anyway
            // — the row we observe below must reflect what the DB did.
            const pending = callEdge(ctx.harness, lane, `DELETE ${target}`, request, ctx.t0);
            queueMicrotask(() =>
              controller.abort(new DOMException("client gave up", "AbortError")),
            );
            const row = await pending;
            return { ...row, note: "client aborted" };
          };
        });
        const rows = await ctx.burst(tasks);
        const appliedDeletes = ctx.fake.effects.filter(
          (e) => e.startsWith("delete#") && !e.includes("fault"),
        ).length;
        const faulted = ctx.fake.effects.filter(
          (e) => e.startsWith("delete#") && e.includes("fault"),
        ).length;
        // Retry until the client sees a 204 (the faults are exhausted by then).
        ctx.fake.faults.restDelete = () => null;
        const retry = await ctx.one(del(ctx, n, session.accessToken, target));
        const after = await listSlugs(ctx, session.accessToken);

        const invariants: Invariant[] = [
          inv(
            "faults_are_503",
            rows.every((r) => r.status === 204 || r.status === 503),
            `statuses ${JSON.stringify(rows.map((r) => r.status))}`,
          ),
          inv(
            "never_500",
            rows.every((r) => r.status !== 500),
            `statuses ${JSON.stringify(rows.map((r) => r.status))}`,
          ),
          inv(
            "204_count_equals_applied_deletes",
            rows.filter((r) => r.status === 204).length === appliedDeletes,
            `204s=${rows.filter((r) => r.status === 204).length} applied=${appliedDeletes}`,
          ),
          inv(
            "503_count_equals_faults",
            rows.filter((r) => r.status === 503).length === faulted,
            `503s=${rows.filter((r) => r.status === 503).length} faulted=${faulted}`,
          ),
          inv(
            "row_gone_iff_a_delete_applied",
            ctx.fake.has(user, target) === (appliedDeletes === 0),
            `present=${ctx.fake.has(user, target)} applied=${appliedDeletes}`,
          ),
          inv("retry_204", retry.status === 204, `retry status ${retry.status}`),
          inv(
            "converged_absent",
            !ctx.fake.has(user, target) && !after.includes(target),
            `present=${ctx.fake.has(user, target)} list=${JSON.stringify(after)}`,
          ),
          inv(
            "other_intact",
            ctx.fake.has(user, other),
            `other present=${ctx.fake.has(user, other)}`,
          ),
          inv(
            "aborted_lanes_still_answered",
            [...abortLanes].every(
              (lane) =>
                rows[lane] !== undefined &&
                (rows[lane].status === 204 || rows[lane].status === 503),
            ),
            `aborted lanes ${JSON.stringify([...abortLanes])} → ${JSON.stringify([...abortLanes].map((l) => rows[l]?.status))}`,
          ),
          inv(
            "503_bodies_are_generic",
            rows
              .filter((r) => r.status === 503)
              .every((r) => r.code === null || !/simulated|PGRST/.test(r.code)),
            `codes ${JSON.stringify(rows.filter((r) => r.status === 503).map((r) => r.code))}`,
          ),
        ];
        return {
          burst: n + 1,
          inputs: { user, target, faultPlan, abortLanes: [...abortLanes] },
          requests: [...rows, retry],
          invariants,
          observations: { appliedDeletes, faulted, faultKinds: ctx.fake.counters },
        };
      },
    );
    reports.push(report);
    assertEquals(report.broken + report.errored, 0, `S7 failing seeds: ${failingSeeds(report)}`);
  },
);

// ── S8 ───────────────────────────────────────────────────────────────────────

Deno.test(
  "stress s8-rate-limit-atomic: a burst past the per-user budget admits exactly the budget (204) and 429s the rest",
  async () => {
    const report = await runScenario(
      FILE,
      "s8-rate-limit-atomic",
      "single user, burst of GENERAL_USER_LIMIT + k DELETEs within one frozen window",
      async (ctx): Promise<IterationOutcome> => {
        const user = ctx.fake.newUser();
        const session = ctx.fake.mintSession(user);
        const target = SLUGS[ctx.prng.int(0, SLUGS.length - 1)];
        ctx.fake.save(user, target);
        const extra = ctx.prng.int(1, 12);
        const n = GENERAL_USER_LIMIT + extra;
        // Spread the burst across a few client IPs (one device behind several
        // NATs) so the per-IP budget (1200/min) is irrelevant and only the
        // per-user counter decides.
        const rows = await ctx.burst(
          Array.from({ length: n }, (_, lane) =>
            del(
              ctx,
              lane,
              session.accessToken,
              target,
              `${ctx.ip.split(".").slice(0, 3).join(".")}.${lane % 4}`,
            ),
          ),
        );
        const ok = rows.filter((r) => r.status === 204).length;
        const limited = rows.filter((r) => r.status === 429);

        const invariants: Invariant[] = [
          inv(
            "exactly_budget_admitted",
            ok === GENERAL_USER_LIMIT,
            `204s=${ok} expected ${GENERAL_USER_LIMIT}`,
          ),
          inv("rest_429", limited.length === extra, `429s=${limited.length} expected ${extra}`),
          inv(
            "429_coded",
            limited.every((r) => r.code === "rate_limited"),
            `codes ${JSON.stringify([...new Set(limited.map((r) => r.code))])}`,
          ),
          inv(
            "postgrest_calls_equal_admitted",
            (ctx.fake.counters["rest.delete"] ?? 0) === ok,
            `rest.delete=${ctx.fake.counters["rest.delete"] ?? 0} 204s=${ok}`,
          ),
          inv("row_deleted", !ctx.fake.has(user, target), `present=${ctx.fake.has(user, target)}`),
          no5xx(rows),
        ];
        return {
          burst: n,
          inputs: { user, target, extra },
          requests: rows,
          invariants,
          observations: { getUserCalls: ctx.fake.counters["gotrue.get_user"] ?? 0 },
        };
      },
      Math.max(1, Math.min(STRESS_ITER, Math.ceil(STRESS_ITER / 4))),
    );
    reports.push(report);
    assertEquals(report.broken + report.errored, 0, `S8 failing seeds: ${failingSeeds(report)}`);
  },
);

// ── seed → outcome table ─────────────────────────────────────────────────────

Deno.test("stress: write seeds.json (seed → outcome table across scenarios)", async () => {
  const table = reports.flatMap((report) =>
    report.iterations.map((it) => ({
      scenario: report.scenario,
      index: it.index,
      seed: it.seed,
      outcome: it.outcome,
      burst: it.burst,
      statuses: it.statusHistogram,
      failing: it.invariants.filter((i) => !i.holds).map((i) => i.name),
      error: it.error ?? null,
      durationMs: it.durationMs,
      replay: it.replay,
    })),
  );
  const summary = {
    file: FILE,
    campaignSeed: STRESS_SEED,
    iterPerScenario: STRESS_ITER,
    maxBurst: STRESS_MAX_BURST,
    scenarios: reports.map((r) => ({
      scenario: r.scenario,
      executed: r.executed,
      held: r.held,
      broken: r.broken,
      errored: r.errored,
      requests: r.iterations.reduce((sum, it) => sum + it.requests.length, 0),
      durationMs: r.durationMs,
    })),
    executed: table.length,
    requests: reports.reduce(
      (sum, r) => sum + r.iterations.reduce((s, it) => s + it.requests.length, 0),
      0,
    ),
    held: table.filter((t) => t.outcome === "HELD").length,
    broken: table.filter((t) => t.outcome === "BROKEN").length,
    errored: table.filter((t) => t.outcome === "ERROR").length,
    table,
  };
  const path = await writeJson("seeds", summary);
  console.log(
    `[stress] seeds table: executed=${summary.executed} held=${summary.held} broken=${summary.broken} errored=${summary.errored} requests=${summary.requests} → ${path}`,
  );
  assert(summary.executed > 0, "no iterations executed");
});

function failingSeeds(report: ScenarioReport): string {
  return JSON.stringify(
    report.iterations.filter((it) => it.outcome !== "HELD").map((it) => it.seed),
  );
}
