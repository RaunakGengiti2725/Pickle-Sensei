/**
 * stress-edge-http / lens `concurrency` — REAL Postgres half.
 *
 * The in-process file proves what the edge fn does to hostile text before it
 * reaches PostgREST. This file drives the exact writes those routes perform —
 * consent_records INSERT, profiles UPDATE, account_deletion_feedback INSERT —
 * against a disposable postgres:16 with shim_auth.sql + every migration
 * applied (./xc_pg_up.sh), as role `authenticated` with the caller's JWT sub,
 * on N independent connections released from a barrier.
 *
 *   ./xc_pg_up.sh                      # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     STRESS_OUT_DIR=/tmp/stress/ deno test -A --no-check --config deno.json stress_edge_http_pg.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 *
 * Scenarios
 *   PG1 cap parity: a string sanitizeUserText(…, edgeCap) let through (and
 *       the route's own UTF-16 check let through) must be accepted by the
 *       column CHECK it lands in; a 23514 here is a 503 to the user for
 *       input the edge said was fine.
 *   PG2 consent ledger burst: N lanes of one user (two "devices") insert
 *       grants/withdraws concurrently with sanitized hostile text — no lost
 *       insert, unique ids, byte-exact Unicode round trip, append-only
 *       (UPDATE/DELETE → 42501), cross-user insert refused by RLS, fold over
 *       (created_at, id) is total.
 *   PG3 two actors on one profile row: N concurrent full-patch UPDATEs
 *       (what PUT /v1/me/onboarding issues) — the final row equals exactly
 *       one lane's patch (no torn row), every RETURNING row equals its own
 *       patch, forbidden columns (email, provider is allowed; id/created_at
 *       are not) stay refused.
 */
import postgres from "postgres";
import { assert } from "@std/assert";
import { sanitizeUserText } from "../http.ts";
import { Prng } from "./xc_concurrency_harness.ts";
import {
  CAP_SITES,
  finishReport,
  hostileText,
  type Invariant,
  laneSeed,
  longRun,
  type OutcomeRow,
  printInvariants,
  rounds,
  roundSeed,
  sanitizedTextViolations,
  STRESS_BURST,
  STRESS_ITER,
  STRESS_LATENCY_MS,
  STRESS_SEED,
  writeReport,
} from "./stress_edge_http_support.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const FILE = "stress_edge_http_pg.test.ts";
const SCALE = {
  rounds: STRESS_ITER,
  burst: STRESS_BURST,
  latencyMs: STRESS_LATENCY_MS,
};
const wallBudgetMs = (requests: number) => 10_000 + requests * 250;

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

function replay(filter: string, round: number): string {
  return `XC_PG_URL=$XC_PG_URL STRESS_SEED=${STRESS_SEED} STRESS_ROUND=${round} STRESS_BURST=${STRESS_BURST} deno test -A --no-check --config deno.json ${FILE} --filter "${filter}"`;
}

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
  const profile = await sql.unsafe(
    `select id from public.profiles where id = '${userId}'`,
  );
  if (profile.length === 0) {
    await sql.unsafe(
      `insert into public.profiles (id, email, provider) values ('${userId}', '${userId}@example.com', 'google')`,
    );
  }
}

interface PgError {
  code?: string;
  message?: string;
}
function pgCode(error: unknown): string {
  const e = error as PgError;
  return typeof e?.code === "string"
    ? e.code
    : `throw:${String(e?.message ?? error).slice(0, 80)}`;
}

/** Each lane: own connection, own tx as `userId`, wait at the barrier, run,
 * COMMIT (so lanes observe each other — the property under test). */
async function pgBurst<T>(
  sql: Sql,
  lanes: number,
  userIdFor: (lane: number) => string,
  fn: (tx: Tx, lane: number) => Promise<T>,
): Promise<
  Array<{ lane: number; ms: number; result: T | null; error: string | null }>
> {
  const b = barrier();
  let ready = 0;
  return await Promise.all(
    Array.from({ length: lanes }, async (_, lane) => {
      const t0 = performance.now();
      try {
        const result = await sql.begin(async (tx) => {
          await asUser(tx, userIdFor(lane));
          ready += 1;
          if (ready === lanes) b.open();
          await b.gate;
          return await fn(tx, lane);
        });
        return {
          lane,
          ms: Math.round(performance.now() - t0),
          result: result as T,
          error: null,
        };
      } catch (error) {
        return {
          lane,
          ms: Math.round(performance.now() - t0),
          result: null,
          error: pgCode(error),
        };
      }
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "stress-edge-http PG1: every edge-accepted string fits the column CHECK it lands in (real postgres:16)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, {
      max: STRESS_BURST + 2,
      onnotice: () => undefined,
    });
    const scenario = "pg1-cap-parity";
    const rows: OutcomeRow[] = [];
    const invariants: Invariant[] = [];
    const heapBefore = Deno.memoryUsage();
    const t0 = performance.now();
    const replayCmds: Record<string, string> = {};
    const overCap: Record<string, number> = {};
    const checked: Record<string, number> = {};
    let unexpected = 0;
    let maxWall = 0;
    try {
      for (const round of rounds()) {
        const seed = roundSeed(round);
        replayCmds[String(round)] = replay("PG1", round);
        const setup = new Prng(seed ^ 0x9101);
        const userId = setup.uuid();
        await createUser(sql, userId);
        const tw = performance.now();
        const results = await pgBurst(
          sql,
          STRESS_BURST,
          () => userId,
          async (tx, lane) => {
            const prng = new Prng(laneSeed(seed, lane));
            const site = CAP_SITES[prng.int(0, CAP_SITES.length - 1)];
            const raw = prng.int(0, 1)
              ? longRun(prng, site.edgeCap - 3, site.edgeCap + 40)
              : hostileText(prng, site.edgeCap);
            const value = sanitizeUserText(raw, site.edgeCap);
            const reachesDb = site.routeCap === null ||
              value.length <= site.routeCap;
            const chars = Array.from(value).length;
            if (!reachesDb) {
              return { site: site.site, chars, reachesDb, code: "route-400" };
            }
            try {
              await tx.savepoint(async (sp) => {
                switch (site.site) {
                  case "consent_records.consent_version":
                    await sp`insert into public.consent_records (user_id, scope, consent_version, action, source) values (${userId}, 'model_training', ${value}, 'grant', 'stress')`;
                    break;
                  case "consent_records.source":
                    await sp`insert into public.consent_records (user_id, scope, consent_version, action, source) values (${userId}, 'model_training', 'v1', 'grant', ${value})`;
                    break;
                  case "consent_records.capture_mode":
                    await sp`insert into public.consent_records (user_id, scope, consent_version, action, source, capture_mode) values (${userId}, 'model_training', 'v1', 'grant', 'stress', ${value})`;
                    break;
                  case "account_deletion_feedback.details":
                    await sp`insert into public.account_deletion_feedback (user_id, reason, details) values (${userId}, 'other', ${value})`;
                    break;
                  case "account_deletion_feedback.app_version":
                    await sp`insert into public.account_deletion_feedback (user_id, reason, app_version) values (${userId}, 'other', ${value})`;
                    break;
                  case "profiles.skill_level":
                    await sp`update public.profiles set skill_level = ${value} where id = ${userId}`;
                    break;
                  case "profiles.primary_goal":
                    await sp`update public.profiles set primary_goal = ${value} where id = ${userId}`;
                    break;
                  case "profiles.biggest_problem":
                    await sp`update public.profiles set biggest_problem = ${value} where id = ${userId}`;
                    break;
                  case "profiles.first_name":
                    await sp`update public.profiles set first_name = ${value} where id = ${userId}`;
                    break;
                }
              });
              return { site: site.site, chars, reachesDb, code: "ok" };
            } catch (error) {
              return { site: site.site, chars, reachesDb, code: pgCode(error) };
            }
          },
        );
        maxWall = Math.max(maxWall, performance.now() - tw);
        for (const r of results) {
          const v: string[] = [];
          const res = r.result;
          if (!res) {
            v.push(`lane tx failed: ${r.error}`);
            unexpected += 1;
            rows.push({
              scenario,
              round,
              seed,
              lane: r.lane,
              action: "tx",
              status: null,
              ms: r.ms,
              outcome: "BROKEN",
              violations: v,
            });
            continue;
          }
          checked[res.site] = (checked[res.site] ?? 0) + 1;
          if (res.code === "23514") {
            v.push(
              `edge accepted ${res.chars} chars → column CHECK 23514 (route would answer 503)`,
            );
            overCap[res.site] = (overCap[res.site] ?? 0) + 1;
          } else if (res.code !== "ok" && res.code !== "route-400") {
            v.push(`unexpected pg error ${res.code}`);
            unexpected += 1;
          }
          rows.push({
            scenario,
            round,
            seed,
            lane: r.lane,
            action: res.site,
            status: null,
            ms: r.ms,
            outcome: v.length ? "BROKEN" : "HELD",
            violations: v,
            note: `chars=${res.chars} pg=${res.code}`,
          });
        }
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
    invariants.push(
      ...CAP_SITES.map((s) => ({
        name: `PG1 ${s.site}: edge cap ${s.edgeCap}${
          s.routeCap !== null ? ` (route ≤ ${s.routeCap})` : ""
        } accepted by CHECK ≤ ${s.dbCap}`,
        holds: (overCap[s.site] ?? 0) === 0,
        detail: `${checked[s.site] ?? 0} writes, ${
          overCap[s.site] ?? 0
        } × 23514`,
      })),
      {
        name: "PG1 no other error class (42501/22xxx) for sanitized text",
        holds: unexpected === 0,
        detail: `${unexpected} unexpected`,
      },
      {
        name: "R5 bounded wall time per burst",
        holds: maxWall < wallBudgetMs(STRESS_BURST),
        detail: `max ${Math.round(maxWall)}ms`,
      },
    );
    printInvariants(scenario, invariants);
    const report = finishReport({
      scenario,
      file: FILE,
      label: "real column CHECK vs sanitize caps",
      baseSeed: STRESS_SEED,
      scale: SCALE,
      rows,
      invariants,
      observations: { overCap, checked },
      durationMs: Math.round(performance.now() - t0),
      heap: { before: heapBefore, after: Deno.memoryUsage() },
      replay: replayCmds,
    });
    console.log(
      `[stress] wrote ${await writeReport(
        report,
      )} (${report.executed} writes, ${report.broken} broken)`,
    );
    for (const inv of invariants) {
      assert(inv.holds, `${inv.name}: ${inv.detail}`);
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "stress-edge-http PG2: concurrent consent ledger writes — no lost insert, byte-exact Unicode, append-only, RLS",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, {
      max: STRESS_BURST + 2,
      onnotice: () => undefined,
    });
    const scenario = "pg2-consent-ledger-burst";
    const rows: OutcomeRow[] = [];
    const invariants: Invariant[] = [];
    const heapBefore = Deno.memoryUsage();
    const t0 = performance.now();
    const replayCmds: Record<string, string> = {};
    let lost = 0,
      dupIds = 0,
      textMismatch = 0,
      appendOnlyBreach = 0,
      rlsBreach = 0,
      foldNotTotal = 0,
      unsanitized = 0;
    let inserted = 0, maxWall = 0;
    try {
      for (const round of rounds()) {
        const seed = roundSeed(round);
        replayCmds[String(round)] = replay("PG2", round);
        const setup = new Prng(seed ^ 0x9202);
        const userId = setup.uuid();
        const stranger = setup.uuid();
        await createUser(sql, userId);
        await createUser(sql, stranger);
        const sent: Array<
          {
            lane: number;
            scope: string;
            action: string;
            version: string;
            source: string;
            capture: string;
            device: Record<string, unknown>;
          }
        > = [];
        const tw = performance.now();
        const results = await pgBurst(
          sql,
          STRESS_BURST,
          (lane) => (lane === STRESS_BURST - 1 ? stranger : userId),
          async (tx, lane) => {
            const prng = new Prng(laneSeed(seed, lane));
            const scope = [
              "video_analysis",
              "model_training",
              "evaluation_telemetry",
            ][prng.int(0, 2)];
            const action = prng.int(0, 2) === 0 ? "withdraw" : "grant";
            // the caps the column actually enforces (see PG1 for the edge's)
            const version = sanitizeUserText("v" + hostileText(prng, 12), 50) ||
              "v1";
            const source = sanitizeUserText(hostileText(prng, 10), 64) ||
              "mobile";
            const capture = sanitizeUserText(hostileText(prng, 10), 50) ||
              "all";
            const device = {
              model: sanitizeUserText(hostileText(prng, 6), 40),
              lane,
            };
            if (lane === STRESS_BURST - 1) {
              // stranger tries to write INTO the user's ledger → RLS must refuse
              try {
                await tx.savepoint(async (sp) => {
                  await sp`insert into public.consent_records (user_id, scope, consent_version, action, source) values (${userId}, ${scope}, ${version}, ${action}, 'stranger')`;
                });
                return { kind: "rls", code: "ok" };
              } catch (error) {
                return { kind: "rls", code: pgCode(error) };
              }
            }
            sent.push({
              lane,
              scope,
              action,
              version,
              source,
              capture,
              device,
            });
            const [row] =
              await tx`insert into public.consent_records (user_id, scope, consent_version, action, source, capture_mode, device)
            values (${userId}, ${scope}, ${version}, ${action}, ${source}, ${capture}, ${
                sql.json(device)
              }) returning id, created_at`;
            return { kind: "insert", code: "ok", id: row.id as string };
          },
        );
        maxWall = Math.max(maxWall, performance.now() - tw);

        const ledger = await sql.unsafe(
          `select id, scope, consent_version, action, source, capture_mode, device, created_at::text as created_at from public.consent_records where user_id = '${userId}' order by created_at, id`,
        ) as unknown as Array<Record<string, unknown>>;
        const writers = results.filter((r) => r.result?.kind === "insert");
        inserted += ledger.length;
        if (ledger.length !== writers.filter((r) => r.error === null).length) {
          lost += 1;
        }
        if (new Set(ledger.map((r) => r.id)).size !== ledger.length) {
          dupIds += 1;
        }
        for (const s of sent) {
          const stored = ledger.find((r) =>
            (r.device as Record<string, unknown> | null)?.lane === s.lane
          );
          if (!stored) {
            lost += 1;
            continue;
          }
          if (
            stored.consent_version !== s.version ||
            stored.source !== s.source || stored.capture_mode !== s.capture ||
            stored.action !== s.action || stored.scope !== s.scope
          ) textMismatch += 1;
          for (
            const val of [
              stored.consent_version,
              stored.source,
              stored.capture_mode,
            ]
          ) {
            if (
              typeof val === "string" && sanitizedTextViolations(val, 64).length
            ) unsanitized += 1;
          }
        }
        // fold totality: consentStatus orders by (created_at, id); with unique
        // ids that is total. Count same-scope created_at (µs) ties as the
        // observation that makes the secondary key load-bearing.
        for (let i = 1; i < ledger.length; i++) {
          const a = ledger[i - 1], b = ledger[i];
          if (
            a.created_at === b.created_at && a.scope === b.scope &&
            String(a.id) >= String(b.id)
          ) foldNotTotal += 1;
        }
        // RLS
        const rls = results[STRESS_BURST - 1];
        if (!rls.result || rls.result.code !== "42501") rlsBreach += 1;
        // append-only as the owner
        if (ledger.length > 0) {
          const target = ledger[0].id as string;
          for (
            const stmt of [
              `update public.consent_records set consent_version = 'rewritten' where id = '${target}'`,
              `delete from public.consent_records where id = '${target}'`,
            ]
          ) {
            try {
              await sql.begin(async (tx) => {
                await asUser(tx, userId);
                const res = await tx.unsafe(stmt);
                if (res.count && res.count > 0) appendOnlyBreach += 1;
              });
            } catch (error) {
              const code = pgCode(error);
              // 42501 (grant) or the append-only trigger's raise — anything else is unexpected
              if (
                code !== "42501" && !code.startsWith("P0001") &&
                code !== "0A000"
              ) appendOnlyBreach += 1;
            }
          }
        }
        for (const r of results) {
          const res = r.result;
          const v: string[] = [];
          if (res?.kind === "rls" && res.code !== "42501") {
            v.push(
              `stranger insert into another user's ledger → ${res.code} (expected 42501)`,
            );
          }
          if (!res) v.push(`lane failed: ${r.error}`);
          rows.push({
            scenario,
            round,
            seed,
            lane: r.lane,
            action: res?.kind ?? "insert",
            status: null,
            ms: r.ms,
            outcome: v.length ? "BROKEN" : "HELD",
            violations: v,
            note: res?.code ?? r.error ?? undefined,
          });
        }
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
    invariants.push(
      {
        name:
          "PG2 no lost insert: ledger rows == committed lanes; every lane's row is present",
        holds: lost === 0,
        detail: `${lost} lost; ${inserted} rows`,
      },
      {
        name: "PG2 ids unique",
        holds: dupIds === 0,
        detail: `${dupIds} rounds with duplicate ids`,
      },
      {
        name:
          "PG2 byte-exact Unicode round trip of sanitized text (emoji, ZWJ sequences, combining marks, RTL scripts)",
        holds: textMismatch === 0,
        detail: `${textMismatch} mismatches`,
      },
      {
        name: "PG2 stored ledger text is sanitized",
        holds: unsanitized === 0,
        detail: `${unsanitized} unsanitized`,
      },
      {
        name: "PG2 fold order (created_at, id) is total",
        holds: foldNotTotal === 0,
        detail: `${foldNotTotal} ties`,
      },
      {
        name: "PG2 append-only: owner UPDATE/DELETE refused",
        holds: appendOnlyBreach === 0,
        detail: `${appendOnlyBreach} breaches`,
      },
      {
        name: "PG2 RLS: stranger cannot write into another user's ledger",
        holds: rlsBreach === 0,
        detail: `${rlsBreach} breaches`,
      },
      {
        name: "R5 bounded wall time per burst",
        holds: maxWall < wallBudgetMs(STRESS_BURST),
        detail: `max ${Math.round(maxWall)}ms`,
      },
    );
    printInvariants(scenario, invariants);
    const report = finishReport({
      scenario,
      file: FILE,
      label: "consent ledger under concurrent hostile-text inserts",
      baseSeed: STRESS_SEED,
      scale: SCALE,
      rows,
      invariants,
      observations: { inserted },
      durationMs: Math.round(performance.now() - t0),
      heap: { before: heapBefore, after: Deno.memoryUsage() },
      replay: replayCmds,
    });
    console.log(
      `[stress] wrote ${await writeReport(
        report,
      )} (${report.executed} lanes, ${report.broken} broken)`,
    );
    for (const inv of invariants) {
      assert(inv.holds, `${inv.name}: ${inv.detail}`);
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "stress-edge-http PG3: two actors racing full-patch profile UPDATEs — no torn row, RETURNING == own patch, column grants hold",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, {
      max: STRESS_BURST + 2,
      onnotice: () => undefined,
    });
    const scenario = "pg3-profile-two-actors";
    const rows: OutcomeRow[] = [];
    const invariants: Invariant[] = [];
    const heapBefore = Deno.memoryUsage();
    const t0 = performance.now();
    const replayCmds: Record<string, string> = {};
    let torn = 0,
      returningMismatch = 0,
      grantBreach = 0,
      failedLanes = 0,
      maxWall = 0,
      patches = 0;
    const COLS = [
      "skill_level",
      "handedness",
      "primary_goal",
      "biggest_problem",
      "first_name",
      "onboarding_state",
    ] as const;
    try {
      for (const round of rounds()) {
        const seed = roundSeed(round);
        replayCmds[String(round)] = replay("PG3", round);
        const setup = new Prng(seed ^ 0x9303);
        const userId = setup.uuid();
        await createUser(sql, userId);
        const sent = new Map<number, Record<string, string>>();
        const tw = performance.now();
        const results = await pgBurst(
          sql,
          STRESS_BURST,
          () => userId,
          async (tx, lane) => {
            const prng = new Prng(laneSeed(seed, lane));
            const patch = {
              skill_level: sanitizeUserText(
                ["Beginner", "Intermediate", "Advanced"][prng.int(0, 2)] +
                  hostileText(prng, 3),
                64,
              ) || "Beginner",
              handedness: prng.int(0, 1) ? "right" : "left",
              primary_goal:
                sanitizeUserText("Goal " + hostileText(prng, 3), 64) || "Goal",
              biggest_problem: sanitizeUserText(hostileText(prng, 12), 200) +
                ` lane ${lane}`,
              first_name: sanitizeUserText(hostileText(prng, 3) + "N", 40) ||
                "N",
              onboarding_state: "complete",
            };
            sent.set(lane, patch);
            if (lane === STRESS_BURST - 1) {
              // a column outside the grant must be refused regardless of the race
              try {
                await tx.savepoint(async (sp) => {
                  await sp`update public.profiles set email = 'attacker@example.com' where id = ${userId}`;
                });
                return { kind: "grant", code: "ok", row: null };
              } catch (error) {
                return { kind: "grant", code: pgCode(error), row: null };
              }
            }
            const [row] = await tx`update public.profiles set
              skill_level = ${patch.skill_level}, handedness = ${patch.handedness}, primary_goal = ${patch.primary_goal},
              biggest_problem = ${patch.biggest_problem}, first_name = ${patch.first_name}, onboarding_state = ${patch.onboarding_state}
            where id = ${userId}
            returning skill_level, handedness, primary_goal, biggest_problem, first_name, onboarding_state`;
            return {
              kind: "patch",
              code: "ok",
              row: row as Record<string, string>,
            };
          },
        );
        maxWall = Math.max(maxWall, performance.now() - tw);
        const [final] = await sql.unsafe(
          `select skill_level, handedness, primary_goal, biggest_problem, first_name, onboarding_state, email from public.profiles where id = '${userId}'`,
        ) as unknown as Array<Record<string, string>>;
        const winnerLane = Number(
          String(final.biggest_problem).slice(
            String(final.biggest_problem).lastIndexOf(" ") + 1,
          ),
        );
        const winner = sent.get(winnerLane);
        if (!winner) torn += 1;
        else for (const c of COLS) if (final[c] !== winner[c]) torn += 1;
        if (final.email !== `${userId}@example.com`) grantBreach += 1;
        for (const r of results) {
          const v: string[] = [];
          const res = r.result;
          if (!res) {
            failedLanes += 1;
            v.push(`lane failed: ${r.error}`);
          } else if (res.kind === "grant") {
            if (res.code === "ok") {
              grantBreach += 1;
              v.push("UPDATE profiles.email succeeded for authenticated");
            } else if (res.code !== "42501") v.push(`unexpected ${res.code}`);
          } else if (res.row) {
            patches += 1;
            const mine = sent.get(r.lane)!;
            for (const c of COLS) {
              if (res.row[c] !== mine[c]) {
                returningMismatch += 1;
                v.push(`RETURNING ${c} != own patch`);
              }
            }
          }
          rows.push({
            scenario,
            round,
            seed,
            lane: r.lane,
            action: res?.kind ?? "patch",
            status: null,
            ms: r.ms,
            outcome: v.length ? "BROKEN" : "HELD",
            violations: v,
            note: res?.code ?? r.error ?? undefined,
          });
        }
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
    invariants.push(
      {
        name:
          "PG3 final profile row == exactly one lane's full patch (no torn row / lost update within a patch)",
        holds: torn === 0,
        detail: `${torn} torn columns; ${patches} patches`,
      },
      {
        name: "PG3 every RETURNING row equals its own patch",
        holds: returningMismatch === 0,
        detail: `${returningMismatch} mismatches`,
      },
      {
        name:
          "PG3 column grant: authenticated cannot UPDATE profiles.email even mid-race",
        holds: grantBreach === 0,
        detail: `${grantBreach} breaches`,
      },
      {
        name:
          "PG3 no lane failed (no deadlock / serialization error on the single-row hot spot)",
        holds: failedLanes === 0,
        detail: `${failedLanes} failed`,
      },
      {
        name: "R5 bounded wall time per burst",
        holds: maxWall < wallBudgetMs(STRESS_BURST),
        detail: `max ${Math.round(maxWall)}ms`,
      },
    );
    printInvariants(scenario, invariants);
    const report = finishReport({
      scenario,
      file: FILE,
      label: "profile row under concurrent full-patch updates",
      baseSeed: STRESS_SEED,
      scale: SCALE,
      rows,
      invariants,
      observations: { patches },
      durationMs: Math.round(performance.now() - t0),
      heap: { before: heapBefore, after: Deno.memoryUsage() },
      replay: replayCmds,
    });
    console.log(
      `[stress] wrote ${await writeReport(
        report,
      )} (${report.executed} lanes, ${report.broken} broken)`,
    );
    for (const inv of invariants) {
      assert(inv.holds, `${inv.name}: ${inv.detail}`);
    }
  },
});
