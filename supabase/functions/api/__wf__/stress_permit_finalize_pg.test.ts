/**
 * stress · Postgres plane — the exact statements POST /v1/analysis-permits/
 * :id/finalize issues through PostgREST, replayed on a disposable postgres:16
 * with shim_auth.sql + every migration applied (./xc_pg_up.sh), as role
 * `authenticated` with the caller's JWT sub, from N independent connections
 * released from a barrier so the row lock genuinely contends:
 *
 *   select id, status, outcome, created_at from analysis_permits where id=? and user_id=?
 *   update analysis_permits set status='finalized', outcome=? where id=? and user_id=? and status='reserved'
 *     returning id, status, outcome, created_at
 *   select * from access_state()
 *
 * Scenarios (seeded; every round replays from STRESS_SEED):
 *   PG-F1  N racers finalize ONE reserved permit with mixed outcomes → exactly one
 *          row updated, the permit carries the winner's outcome, every loser's
 *          conditional update touches 0 rows (→ the route's 409 path)
 *   PG-F2  duplicate delivery after finalization → select sees the settled row
 *          (route's idempotent 200), conditional update 0 rows, updated_at frozen
 *   PG-F3  another user's permit → RLS hides it from select AND update
 *   PG-F4  finalize (abstention) racing apply_synced_shot(scored) on the same
 *          permit → at most one scored shot, at most one free rating spent,
 *          permit ends in exactly one of {finalized/<abstention>, finalized/scored}
 *   PG-F5  reserve → finalize → reserve … never spends a free rating; two scored
 *          syncs then exhaust it; a finalize on a scored permit is refused (0 rows)
 *          and a duplicate scored sync replays idempotently (still 2)
 *
 *   ./xc_pg_up.sh   # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres STRESS_PG_LANES=16 STRESS_PG_ROUNDS=8 \
 *     deno test -A --no-check --config deno.json stress_permit_finalize_pg.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { Prng } from "./xc_concurrency_harness.ts";
import {
  envInt,
  histogram,
  latencySummary,
  RELEASABLE_OUTCOMES,
  STRESS_SEED,
  writeArtifact,
} from "./stress_permit_finalize_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const LANES = envInt("STRESS_PG_LANES", 12);
const ROUNDS = envInt("STRESS_PG_ROUNDS", 3);

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

interface PermitView {
  id: string;
  status: string;
  outcome: string | null;
  created_at: string;
}

interface LaneRow {
  round: number;
  lane: number;
  op: string;
  result: string;
  serverStartMs: number;
  serverEndMs: number;
  clientMs: number;
}

interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
}

const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "config-1",
};

function scoredShot(
  id: string,
  analysisPermitId: string,
): Record<string, unknown> {
  return {
    id,
    analysisPermitId,
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-04T10:00:00.000Z",
    startMs: 0,
    contactMs: 100,
    endMs: 200,
    overallScore: 7,
    confidence: 0.9,
    resultKind: "scored",
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
  };
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
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

async function serverNowMs(tx: Tx): Promise<number> {
  const r = await tx.unsafe(
    `select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`,
  );
  return Number(r[0].t);
}

/** Seeded ids repeat across runs against the same disposable DB: remove what
 * an earlier run with this seed left (the auth.users cascade + the identity
 * ledger row that survives deletion by design). Owner-role setup only. */
async function createUser(sql: Sql, userId: string): Promise<void> {
  const sub = `g-${userId}`;
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `delete from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('google', '${sub}')`,
  );
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', '${sub}', '${userId}', '{"sub":"${sub}"}')`,
  );
}

/** The route reserves through POST /v1/analysis-permits → reserve_analysis_permit(text). */
async function reserve(
  sql: Sql,
  userId: string,
  key: string,
): Promise<{ result: string; permitId: string | null }> {
  let out!: { result: string; permitId: string | null };
  await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId);
    const r = await tx.unsafe(
      `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
    );
    out = {
      result: String(r[0].result),
      permitId: r[0].permit_id ? String(r[0].permit_id) : null,
    };
  });
  return out;
}

/** Route statement 1 — the lookup (`.maybeSingle()` → 0 or 1 row). */
async function routeSelect(
  tx: Tx,
  permitId: string,
  userId: string,
): Promise<PermitView | null> {
  const r = await tx.unsafe(
    `select id::text, status, outcome, created_at::text from public.analysis_permits where id = '${permitId}' and user_id = '${userId}'`,
  );
  return r.length ? (r[0] as unknown as PermitView) : null;
}

/** Route statement 2 — the conditional finalize with representation. */
async function routeUpdate(
  tx: Tx,
  permitId: string,
  userId: string,
  outcome: string,
): Promise<PermitView | null> {
  const r = await tx.unsafe(
    `update public.analysis_permits set status = 'finalized', outcome = '${outcome}'
      where id = '${permitId}' and user_id = '${userId}' and status = 'reserved'
      returning id::text, status, outcome, created_at::text`,
  );
  return r.length ? (r[0] as unknown as PermitView) : null;
}

/** Route statement 3 — access_state() for the response payload. */
async function routeAccessState(
  tx: Tx,
): Promise<{ premium: boolean; scored_count: number; reserved_count: number }> {
  const r = await tx.unsafe(
    `select premium, scored_count, reserved_count from public.access_state()`,
  );
  return {
    premium: Boolean(r[0].premium),
    scored_count: Number(r[0].scored_count),
    reserved_count: Number(r[0].reserved_count),
  };
}

async function applySyncedShot(
  tx: Tx,
  shot: Record<string, unknown>,
): Promise<string> {
  const r = await tx.unsafe(
    `select public.apply_synced_shot($1::text::jsonb) as result`,
    [JSON.stringify(shot)],
  );
  return String(r[0].result);
}

/** Owner-role read of the permit row, including updated_at (not in the route's view). */
async function ownerPermit(sql: Sql, permitId: string) {
  const r = await sql.unsafe(
    `select status, outcome, updated_at::text as updated_at from public.analysis_permits where id = '${permitId}'`,
  );
  return r.length
    ? {
      status: String(r[0].status),
      outcome: r[0].outcome as string | null,
      updatedAt: String(r[0].updated_at),
    }
    : null;
}

/** shots carry no permit id; every scenario user is fresh, so the user's
 * scored rows are the permit's consumers. */
async function ownerScoredShots(sql: Sql, userId: string): Promise<number> {
  const r = await sql.unsafe(
    `select count(*)::int as n from public.shots where user_id = '${userId}' and result_kind = 'scored'`,
  );
  return Number(r[0].n);
}

/** Run `fn` on `lanes` independent connections; each opens a tx as the caller,
 * waits at the barrier, runs fn, COMMITs. */
async function burst(
  sql: Sql,
  lanes: number,
  userIdFor: (lane: number) => string,
  fn: (tx: Tx, lane: number) => Promise<string>,
  op: (lane: number) => string,
  round: number,
): Promise<LaneRow[]> {
  const b = barrier();
  let ready = 0;
  const rows: LaneRow[] = [];
  const all = Promise.all(
    Array.from({ length: lanes }, (_, lane) =>
      sql.begin(async (tx) => {
        const t = tx as unknown as Tx;
        await asUser(t, userIdFor(lane));
        ready += 1;
        await b.gate;
        const t0 = performance.now();
        const serverStartMs = await serverNowMs(t);
        const result = await fn(t, lane);
        const serverEndMs = await serverNowMs(t);
        rows.push({
          round,
          lane,
          op: op(lane),
          result,
          serverStartMs,
          serverEndMs,
          clientMs: Math.round((performance.now() - t0) * 100) / 100,
        });
      })),
  );
  while (ready < lanes) await new Promise((r) => setTimeout(r, 1));
  b.open();
  await all;
  rows.sort((a, b) => a.lane - b.lane);
  return rows;
}

function overlapCount(rows: LaneRow[]): number {
  let n = 0;
  for (const a of rows) {
    if (
      rows.some((b) =>
        b !== a && a.serverStartMs < b.serverEndMs &&
        b.serverStartMs < a.serverEndMs
      )
    ) n++;
  }
  return n;
}

function inv(
  invariants: Invariant[],
  name: string,
  holds: boolean,
  detail: string,
) {
  invariants.push({ name, holds, detail });
}

async function scenario(
  name: string,
  run: (
    sql: Sql,
    rng: Prng,
    rows: LaneRow[],
    invariants: Invariant[],
    observations: Record<string, unknown>,
  ) => Promise<void>,
) {
  const sql = postgres(PG_URL, { max: LANES + 2 });
  const seed = (STRESS_SEED ^ fnv1a(name)) >>> 0;
  const rng = new Prng(seed);
  const rows: LaneRow[] = [];
  const invariants: Invariant[] = [];
  const observations: Record<string, unknown> = {};
  const t0 = performance.now();
  try {
    await run(sql, rng, rows, invariants, observations);
  } finally {
    await sql.end();
  }
  const report = {
    campaign: "stress_permit_finalize_pg",
    plane:
      "docker postgres:16 + shim_auth.sql + every supabase/migrations/*.sql; role authenticated per lane",
    scenario: name,
    seed,
    scale: { lanes: LANES, rounds: ROUNDS },
    results: histogram(rows.map((r) => `${r.op}:${r.result}`)),
    lanesOverlappingAnotherLane: overlapCount(rows),
    laneLatency: latencySummary(rows.map((r) => r.clientMs)),
    invariants,
    observations,
    durationMs: Math.round(performance.now() - t0),
    replay:
      `XC_PG_URL=<from ./xc_pg_up.sh> STRESS_SEED=${STRESS_SEED} STRESS_PG_LANES=${LANES} STRESS_PG_ROUNDS=${ROUNDS} deno test -A --no-check --config deno.json stress_permit_finalize_pg.test.ts --filter "${name}"`,
    lanes: rows,
  };
  const path = await writeArtifact(`pg_${name}.json`, report);
  const broken = invariants.filter((i) => !i.holds);
  console.log(
    `[stress pg] ${name}: ${rows.length} lane ops · ${
      JSON.stringify(report.results)
    } · overlap ${report.lanesOverlappingAnotherLane}/${rows.length} · ${broken.length} broken → ${path}`,
  );
  for (const i of broken) {
    console.log(`[stress pg]   BROKEN ${i.name} — ${i.detail}`);
  }
  assertEquals(broken.map((i) => `${i.name}: ${i.detail}`), []);
  return report;
}

Deno.test({
  name:
    "stress pg F1: N racers finalize one reserved permit with mixed outcomes — one winner, losers 0 rows",
  ignore,
  async fn() {
    await scenario(
      "f1_finalize_race",
      async (sql, rng, rows, invariants, observations) => {
        const winners: string[] = [];
        let overlapped = 0;
        for (let r = 0; r < ROUNDS; r++) {
          const uid = rng.uuid();
          await createUser(sql, uid);
          const reserved = await reserve(sql, uid, `f1-${r}-${rng.uuid()}`);
          inv(
            invariants,
            `round ${r}: reserve accepted`,
            reserved.result === "accepted" && !!reserved.permitId,
            reserved.result,
          );
          const permitId = reserved.permitId!;
          const outcomes = Array.from(
            { length: LANES },
            () =>
              RELEASABLE_OUTCOMES[rng.int(0, RELEASABLE_OUTCOMES.length - 1)],
          );
          const views: Array<PermitView | null> = [];
          const out = await burst(
            sql,
            LANES,
            () => uid,
            async (tx, lane) => {
              const found = await routeSelect(tx, permitId, uid);
              if (!found) {
                return "lookup_missing";
              }
              const updated = await routeUpdate(
                tx,
                permitId,
                uid,
                outcomes[lane],
              );
              views[lane] = updated;
              const access = await routeAccessState(tx);
              return updated
                ? `updated:${updated.outcome}:reserved=${access.reserved_count}`
                : `0rows:reserved=${access.reserved_count}`;
            },
            (lane) => `finalize.${outcomes[lane]}`,
            r,
          );
          rows.push(...out);
          overlapped += overlapCount(out);
          const winnersHere = out.filter((x) =>
            x.result.startsWith("updated:")
          );
          const final = await ownerPermit(sql, permitId);
          winners.push(final?.outcome ?? "?");
          inv(
            invariants,
            `round ${r}: exactly one lane updated a row`,
            winnersHere.length === 1,
            JSON.stringify(histogram(out.map((x) => x.result))),
          );
          inv(
            invariants,
            `round ${r}: permit finalized with the winner's outcome`,
            final?.status === "finalized" && winnersHere.length === 1 &&
              final.outcome === outcomes[winnersHere[0].lane],
            `${final?.status}/${final?.outcome} winner lane ${
              winnersHere[0]?.lane
            } wanted ${outcomes[winnersHere[0]?.lane]}`,
          );
          inv(
            invariants,
            `round ${r}: winner's view + access_state consistent (reserved_count 0 after finalize)`,
            winnersHere.length === 1 &&
              winnersHere[0].result === `updated:${final?.outcome}:reserved=0`,
            winnersHere[0]?.result ?? "-",
          );
          inv(
            invariants,
            `round ${r}: every loser's conditional update touched 0 rows`,
            out.filter((x) => x.result.startsWith("0rows:")).length ===
              LANES - 1,
            JSON.stringify(histogram(out.map((x) => x.result))),
          );
        }
        observations.winningOutcomes = histogram(winners);
        inv(
          invariants,
          "lanes genuinely overlapped on the server",
          overlapped > 0,
          `${overlapped}/${rows.length}`,
        );
      },
    );
  },
});

Deno.test({
  name:
    "stress pg F2: duplicate delivery after finalization — settled row visible, conditional update 0 rows, updated_at frozen",
  ignore,
  async fn() {
    await scenario(
      "f2_duplicate_delivery",
      async (sql, rng, rows, invariants) => {
        for (let r = 0; r < ROUNDS; r++) {
          const uid = rng.uuid();
          await createUser(sql, uid);
          const reserved = await reserve(sql, uid, `f2-${r}-${rng.uuid()}`);
          const permitId = reserved.permitId!;
          const outcome =
            RELEASABLE_OUTCOMES[rng.int(0, RELEASABLE_OUTCOMES.length - 1)];
          await sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, uid);
            const first = await routeUpdate(
              tx as unknown as Tx,
              permitId,
              uid,
              outcome,
            );
            inv(
              invariants,
              `round ${r}: first finalize updated the row`,
              first?.status === "finalized" && first.outcome === outcome,
              JSON.stringify(first),
            );
          });
          const before = await ownerPermit(sql, permitId);
          // N duplicate copies of the SAME finalize (the client's retry storm)
          const out = await burst(
            sql,
            LANES,
            () => uid,
            async (tx) => {
              const found = await routeSelect(tx, permitId, uid);
              if (!found) return "lookup_missing";
              if (found.status !== "reserved") {
                // the route answers from the lookup: same outcome → 200, else 409
                return found.outcome === outcome
                  ? "settled_same_outcome"
                  : `settled_other:${found.outcome}`;
              }
              const updated = await routeUpdate(tx, permitId, uid, outcome);
              return updated ? "updated_again" : "0rows";
            },
            () => "dup.finalize",
            r,
          );
          rows.push(...out);
          // and N conflicting copies straight at the conditional update (the race path)
          const other = RELEASABLE_OUTCOMES.find((o) => o !== outcome)!;
          const conflicts = await burst(
            sql,
            LANES,
            () => uid,
            async (tx) => {
              const updated = await routeUpdate(tx, permitId, uid, other);
              return updated ? "REWROTE" : "0rows";
            },
            () => "dup.conflictUpdate",
            r,
          );
          rows.push(...conflicts);
          const after = await ownerPermit(sql, permitId);
          inv(
            invariants,
            `round ${r}: every duplicate saw the settled row`,
            out.every((x) => x.result === "settled_same_outcome"),
            JSON.stringify(histogram(out.map((x) => x.result))),
          );
          inv(
            invariants,
            `round ${r}: every conflicting update touched 0 rows`,
            conflicts.every((x) => x.result === "0rows"),
            JSON.stringify(histogram(conflicts.map((x) => x.result))),
          );
          inv(
            invariants,
            `round ${r}: row frozen (status/outcome/updated_at)`,
            JSON.stringify(before) === JSON.stringify(after),
            `${JSON.stringify(before)} → ${JSON.stringify(after)}`,
          );
        }
      },
    );
  },
});

Deno.test({
  name:
    "stress pg F3: another user's reserved permit — RLS hides it from the lookup and the update",
  ignore,
  async fn() {
    await scenario("f3_foreign_permit", async (sql, rng, rows, invariants) => {
      for (let r = 0; r < ROUNDS; r++) {
        const owner = rng.uuid();
        await createUser(sql, owner);
        const reserved = await reserve(sql, owner, `f3-${r}-${rng.uuid()}`);
        const permitId = reserved.permitId!;
        const intruders = Array.from({ length: LANES }, () => rng.uuid());
        for (const id of intruders) await createUser(sql, id);
        const out = await burst(
          sql,
          LANES,
          (lane) => intruders[lane],
          async (tx, lane) => {
            // as the route would: lookup scoped by user_id = caller, then update scoped the same way
            const found = await routeSelect(tx, permitId, intruders[lane]);
            const updated = await routeUpdate(
              tx,
              permitId,
              intruders[lane],
              "cancelled",
            );
            // and the unscoped variants — RLS alone must still hide the row
            const unscopedFound = await tx.unsafe(
              `select id from public.analysis_permits where id = '${permitId}'`,
            );
            const unscopedUpdate = await tx.unsafe(
              `update public.analysis_permits set status = 'finalized', outcome = 'cancelled' where id = '${permitId}' returning id`,
            );
            return `lookup=${found ? "VISIBLE" : "hidden"} update=${
              updated ? "WROTE" : "0rows"
            } rls_select=${unscopedFound.length} rls_update=${unscopedUpdate.length}`;
          },
          () => "foreign.finalize",
          r,
        );
        rows.push(...out);
        const after = await ownerPermit(sql, permitId);
        inv(
          invariants,
          `round ${r}: no intruder saw or wrote the row`,
          out.every((x) =>
            x.result === "lookup=hidden update=0rows rls_select=0 rls_update=0"
          ),
          JSON.stringify(histogram(out.map((x) => x.result))),
        );
        inv(
          invariants,
          `round ${r}: permit still reserved`,
          after?.status === "reserved" && after.outcome === null,
          JSON.stringify(after),
        );
      }
    });
  },
});

Deno.test({
  name:
    "stress pg F4: finalize(abstention) racing apply_synced_shot(scored) on one permit — ≤1 scored shot, ≤1 free rating spent",
  ignore,
  async fn() {
    await scenario(
      "f4_finalize_vs_scored_sync",
      async (sql, rng, rows, invariants, observations) => {
        const endings: string[] = [];
        for (let r = 0; r < ROUNDS; r++) {
          const uid = rng.uuid();
          await createUser(sql, uid);
          const reserved = await reserve(sql, uid, `f4-${r}-${rng.uuid()}`);
          const permitId = reserved.permitId!;
          const abstention =
            RELEASABLE_OUTCOMES[rng.int(0, RELEASABLE_OUTCOMES.length - 1)];
          // half the lanes finalize (the route), half sync a scored shot (the RPC), interleaved by seed
          const roles: Array<"finalize" | "sync"> = Array.from(
            { length: LANES },
            (_, lane) => (lane % 2 === 0 ? "finalize" : "sync"),
          );
          for (let i = roles.length - 1; i > 0; i--) {
            const j = rng.int(0, i);
            [roles[i], roles[j]] = [roles[j], roles[i]];
          }
          const shotIds = roles.map(() => rng.uuid());
          const out = await burst(
            sql,
            LANES,
            () => uid,
            async (tx, lane) => {
              if (roles[lane] === "finalize") {
                const found = await routeSelect(tx, permitId, uid);
                if (!found) return "lookup_missing";
                if (found.status !== "reserved") {
                  return found.outcome === abstention
                    ? "settled_same"
                    : `settled_other:${found.outcome}`;
                }
                const updated = await routeUpdate(
                  tx,
                  permitId,
                  uid,
                  abstention,
                );
                if (updated) return `updated:${updated.outcome}`;
                const settled = await routeSelect(tx, permitId, uid);
                return `0rows→409:${
                  settled?.outcome ?? settled?.status ?? "unknown"
                }`;
              }
              return `rpc:${await applySyncedShot(
                tx,
                scoredShot(shotIds[lane], permitId),
              )}`;
            },
            (lane) =>
              roles[lane] === "finalize"
                ? `finalize.${abstention}`
                : "sync.scored",
            r,
          );
          rows.push(...out);
          const permit = await ownerPermit(sql, permitId);
          const scoredShots = await ownerScoredShots(sql, uid);
          let access!: {
            premium: boolean;
            scored_count: number;
            reserved_count: number;
          };
          await sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, uid);
            access = await routeAccessState(tx as unknown as Tx);
          });
          const finalizeWon = out.some((x) => x.result.startsWith("updated:"));
          const syncAccepted = out.filter((x) =>
            x.result === "rpc:accepted"
          ).length;
          endings.push(`${permit?.status}/${permit?.outcome}`);
          inv(
            invariants,
            `round ${r}: at most one scored shot for the permit`,
            scoredShots <= 1,
            `${scoredShots}`,
          );
          inv(
            invariants,
            `round ${r}: at most one free rating spent`,
            access.scored_count <= 1 && access.scored_count === scoredShots,
            `scored_count=${access.scored_count} shots=${scoredShots}`,
          );
          inv(
            invariants,
            `round ${r}: permit settled once, no reserved hold left`,
            permit?.status === "finalized" && access.reserved_count === 0,
            `${permit?.status}/${permit?.outcome} reserved=${access.reserved_count}`,
          );
          inv(
            invariants,
            `round ${r}: exactly one consumer — finalize XOR one accepted sync`,
            (finalizeWon && syncAccepted === 0 &&
              permit?.outcome === abstention) ||
              (!finalizeWon && syncAccepted === 1 &&
                permit?.outcome === "scored"),
            `finalizeWon=${finalizeWon} syncAccepted=${syncAccepted} permit=${permit?.status}/${permit?.outcome} ${
              JSON.stringify(histogram(out.map((x) => x.result)))
            }`,
          );
          inv(
            invariants,
            `round ${r}: losers saw the settled state (route 409 / rpc permit_not_reserved)`,
            out.every((x) =>
              x.result.startsWith("updated:") || x.result === "rpc:accepted" ||
              x.result === "rpc:access.permit_not_reserved" ||
              x.result.startsWith("0rows→409:") ||
              x.result === "settled_same" ||
              x.result.startsWith("settled_other:")
            ),
            JSON.stringify(histogram(out.map((x) => x.result))),
          );
        }
        observations.endings = histogram(endings);
      },
    );
  },
});

Deno.test({
  name:
    "stress pg F5: reserve→finalize→reserve never spends a free rating; two scored syncs exhaust it; finalize on a scored permit refused",
  ignore,
  async fn() {
    await scenario(
      "f5_free_rating_ledger",
      async (sql, rng, rows, invariants, observations) => {
        const uid = rng.uuid();
        await createUser(sql, uid);
        const cycles = Math.max(3, ROUNDS);
        const trail: string[] = [];
        for (let c = 0; c < cycles; c++) {
          const reserved = await reserve(
            sql,
            uid,
            `f5-cycle-${c}-${rng.uuid()}`,
          );
          const outcome =
            RELEASABLE_OUTCOMES[rng.int(0, RELEASABLE_OUTCOMES.length - 1)];
          let access!: {
            premium: boolean;
            scored_count: number;
            reserved_count: number;
          };
          let updated: PermitView | null = null;
          await sql.begin(async (tx) => {
            const t = tx as unknown as Tx;
            await asUser(t, uid);
            updated = reserved.permitId
              ? await routeUpdate(t, reserved.permitId, uid, outcome)
              : null;
            access = await routeAccessState(t);
          });
          trail.push(
            `${reserved.result}→${
              updated ? "finalized" : "no-row"
            }→scored=${access.scored_count},reserved=${access.reserved_count}`,
          );
          inv(
            invariants,
            `cycle ${c}: reserve accepted, released by finalize, nothing spent`,
            reserved.result === "accepted" && updated !== null &&
              access.scored_count === 0 && access.reserved_count === 0,
            trail[trail.length - 1],
          );
        }
        // two scored ratings
        const scoredPermits: string[] = [];
        for (let k = 0; k < 2; k++) {
          const reserved = await reserve(
            sql,
            uid,
            `f5-scored-${k}-${rng.uuid()}`,
          );
          inv(
            invariants,
            `scored ${k}: reserve accepted`,
            reserved.result === "accepted",
            reserved.result,
          );
          scoredPermits.push(reserved.permitId!);
          const shotId = rng.uuid();
          let result = "";
          let replay = "";
          await sql.begin(async (tx) => {
            const t = tx as unknown as Tx;
            await asUser(t, uid);
            result = await applySyncedShot(
              t,
              scoredShot(shotId, reserved.permitId!),
            );
            // duplicate delivery of the same shot id (client retry) inside the same session
            replay = await applySyncedShot(
              t,
              scoredShot(shotId, reserved.permitId!),
            );
          });
          rows.push({
            round: k,
            lane: 0,
            op: "sync.scored",
            result,
            serverStartMs: 0,
            serverEndMs: 0,
            clientMs: 0,
          });
          rows.push({
            round: k,
            lane: 1,
            op: "sync.scored.replay",
            result: replay,
            serverStartMs: 0,
            serverEndMs: 0,
            clientMs: 0,
          });
          inv(
            invariants,
            `scored ${k}: accepted once, replay idempotent`,
            result === "accepted" && replay === "accepted",
            `${result} / ${replay}`,
          );
        }
        let access!: {
          premium: boolean;
          scored_count: number;
          reserved_count: number;
        };
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, uid);
          access = await routeAccessState(tx as unknown as Tx);
        });
        inv(
          invariants,
          "two free ratings spent exactly",
          access.scored_count === 2 && access.reserved_count === 0,
          JSON.stringify(access),
        );
        // third reserve refused; a stale finalize on a consumed permit refused; N duplicate scored syncs of a NEW shot id on a consumed permit refused
        const third = await reserve(sql, uid, `f5-third-${rng.uuid()}`);
        inv(
          invariants,
          "third reserve refused (paywall)",
          third.result === "access.paywall_required" && third.permitId === null,
          third.result,
        );
        const consumed = scoredPermits[0];
        const staleFinalize = await burst(
          sql,
          LANES,
          () => uid,
          async (tx, lane) => {
            if (lane % 2 === 0) {
              const updated = await routeUpdate(tx, consumed, uid, "cancelled");
              return updated ? "REWROTE_SCORED_PERMIT" : "0rows";
            }
            return `rpc:${await applySyncedShot(
              tx,
              scoredShot(rng.uuid(), consumed),
            )}`;
          },
          (lane) => lane % 2 === 0 ? "stale.finalize" : "stale.sync",
          cycles,
        );
        rows.push(...staleFinalize);
        const scoredAfter = await ownerScoredShots(sql, uid);
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, uid);
          access = await routeAccessState(tx as unknown as Tx);
        });
        inv(
          invariants,
          "consumed permit: finalize 0 rows, extra scored syncs refused, still two shots, still 2 spent",
          staleFinalize.every((x) =>
            x.result === "0rows" ||
            x.result === "rpc:access.permit_not_reserved"
          ) && scoredAfter === 2 && access.scored_count === 2,
          `${
            JSON.stringify(histogram(staleFinalize.map((x) => x.result)))
          } shots=${scoredAfter} access=${JSON.stringify(access)}`,
        );
        observations.trail = trail;
        observations.finalAccess = access;
      },
    );
  },
});
