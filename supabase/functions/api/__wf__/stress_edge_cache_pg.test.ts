/**
 * STRESS · edge-cache · lens = concurrency · Postgres leg.
 *
 * The cache under test (cache.ts) never touches Postgres, but the route H1
 * drives through it — POST /v1/shots:sync — commits through
 * public.apply_synced_shot() and busts the rank/progress keys afterwards.
 * This file re-runs the write side of that route against a REAL disposable
 * postgres:16 with every migration applied (`./xc_pg_up.sh` → XC_PG_URL) as
 * seeded mixed bursts: duplicate permit keys, the same shot delivered from N
 * open transactions, two different shots on one permit, a third shot against
 * the two-rating free allowance. Asserted per seed:
 *
 *   idempotency    every duplicate delivery answers `accepted`
 *   no dup rows    one shots row per distinct accepted shot id
 *   no double spend ≤ 2 scored rows, ledger == scored rows, ≤ 2 permits
 *                  reserved, every permit finalized at most once
 *   no deadlock    the burst returns within a bounded wall time, no SQL error
 *
 * Skipped (ignored, NOT passed) when XC_PG_URL is unset. Fast by default
 * (STRESS_ITER=4); the campaign runs it with STRESS_ITER=75 like the in-process
 * scenarios. Seed → outcome table: artifacts/stress-edge-cache/latest/PG1_*.json
 */
import postgres from "postgres";
import { assertEquals } from "@std/assert";
import { Prng } from "./xc_concurrency_harness.ts";
import {
  brokenSeeds,
  now,
  runScenario,
  sleep,
  STRESS_ITER,
} from "./stress_edge_cache_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? "";
const ignore = PG_URL === "";
const FILE = "stress_edge_cache_pg.test.ts";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

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

function shotPayload(
  id: string,
  analysisPermitId: string,
): Record<string, unknown> {
  return {
    id,
    analysisPermitId,
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
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

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function createUser(
  sql: Sql,
  userId: string,
  sub: string,
): Promise<void> {
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

interface Lane {
  op: string;
  result: string;
  permitId?: string;
  ms: number;
}

/** Every lane opens its own transaction, sets the caller, waits at the
 * barrier, runs `fn` and COMMITs — N genuinely concurrent RPC calls. */
async function burst(
  sql: Sql,
  userId: string,
  fns: Array<(tx: Tx) => Promise<Omit<Lane, "ms">>>,
): Promise<Lane[]> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let ready = 0;
  const lanes: Lane[] = [];
  const all = Promise.all(
    fns.map((fn) =>
      sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, userId);
        ready += 1;
        await gate;
        const t0 = now();
        try {
          lanes.push({
            ...(await fn(tx as unknown as Tx)),
            ms: Math.round(now() - t0),
          });
        } catch (error) {
          lanes.push({
            op: "error",
            result: `sql.error: ${
              error instanceof Error ? error.message : String(error)
            }`,
            ms: Math.round(now() - t0),
          });
          throw error;
        }
      }).catch(() => undefined)
    ),
  );
  while (ready < fns.length) await sleep(1);
  open();
  await all;
  return lanes;
}

const reserve = (key: string) => async (tx: Tx): Promise<Omit<Lane, "ms">> => {
  const r = await tx.unsafe(
    `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
  );
  return {
    op: `reserve:${key}`,
    result: String(r[0].result),
    permitId: r[0].permit_id ? String(r[0].permit_id) : undefined,
  };
};

const apply =
  (shot: Record<string, unknown>, op: string) =>
  async (tx: Tx): Promise<Omit<Lane, "ms">> => {
    const r = await tx.unsafe(
      `select public.apply_synced_shot($1::text::jsonb) as result`,
      [JSON.stringify(shot)],
    );
    return { op, result: String(r[0].result) };
  };

Deno.test({
  name:
    "PG1 real postgres: duplicate permit keys + duplicated/over-subscribed shot syncs — one row per shot, ≤2 ratings, ledger exact",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 24 });
    try {
      const table = await runScenario(
        FILE,
        "PG1_real_postgres_sync_bursts",
        "PG1 real postgres",
        STRESS_ITER,
        async (seed, ledger, inputs) => {
          const prng = new Prng(seed);
          const userId = prng.uuid();
          const sub = `stress-pg-${seed}`;
          await createUser(sql, userId, sub);
          const keys = prng.int(1, 3); // distinct idempotency keys
          const dupPerKey = prng.int(1, 3); // concurrent duplicates of each key
          Object.assign(inputs, { userId, keys, dupPerKey });

          // 1. reserve: keys × dupPerKey concurrent transactions, free account
          const t0 = now();
          const reserves = await burst(
            sql,
            userId,
            Array.from(
              { length: keys * dupPerKey },
              (_, i) => reserve(`k${i % keys}-${seed}`),
            ),
          );
          const byKey = new Map<string, Set<string>>();
          for (const l of reserves) {
            if (l.op === "error") {
              ledger.broken(`reserve lane errored: ${l.result}`);
            }
            if (l.result === "accepted" && l.permitId) {
              const set = byKey.get(l.op) ?? new Set<string>();
              set.add(l.permitId);
              byKey.set(l.op, set);
            }
          }
          for (const [key, ids] of byKey) {
            if (ids.size !== 1) {
              ledger.broken(`key ${key} yielded ${ids.size} permit ids`);
            }
          }
          const permitIds = [...byKey.values()].map((s) => [...s][0]);
          const paywalled = reserves.filter((l) =>
            l.result === "access.paywall_required"
          ).length;
          if (permitIds.length > 2) {
            ledger.broken(
              `${permitIds.length} permits reserved on a 2-rating free account`,
            );
          }
          if (permitIds.length !== Math.min(2, keys)) {
            ledger.broken(
              `${permitIds.length} distinct permits for ${keys} keys (expected ${
                Math.min(2, keys)
              }); paywalled=${paywalled}`,
            );
          }
          for (const l of reserves) {
            if (
              l.result !== "accepted" && l.result !== "access.paywall_required"
            ) ledger.broken(`reserve → ${l.result}`);
          }
          ledger.count("reserve.lanes", reserves.length);
          ledger.count("reserve.paywalled", paywalled);

          // 2. apply: shot A on permit 0 delivered from D lanes; shot B ALSO on
          //    permit 0 (over-subscription); shot C on permit 1 (if any), once or
          //    duplicated; a replay of A after the burst
          const dupA = prng.int(2, 5);
          const shotA = prng.uuid();
          const shotB = prng.uuid();
          const shotC = prng.uuid();
          const dupC = prng.int(1, 2);
          Object.assign(inputs, { dupA, dupC, permits: permitIds.length });
          const fns: Array<(tx: Tx) => Promise<Omit<Lane, "ms">>> = [];
          for (let i = 0; i < dupA; i += 1) {
            fns.push(apply(shotPayload(shotA, permitIds[0]), "apply:A"));
          }
          fns.push(
            apply(
              shotPayload(shotB, permitIds[0]),
              "apply:B(same permit as A)",
            ),
          );
          if (permitIds[1]) {
            for (let i = 0; i < dupC; i += 1) {
              fns.push(apply(shotPayload(shotC, permitIds[1]), "apply:C"));
            }
          }
          const applies = await burst(sql, userId, prng.shuffle(fns));
          const wall = now() - t0;
          ledger.count("wallMs", Math.round(wall));
          if (wall > 15_000) {
            ledger.broken(
              `burst took ${wall.toFixed(0)} ms (deadlock / lock convoy)`,
            );
          }

          const acceptedA = applies.filter((l) =>
            l.op === "apply:A" && l.result === "accepted"
          )
            .length;
          const acceptedB = applies.filter((l) =>
            l.op.startsWith("apply:B") && l.result === "accepted"
          ).length;
          const acceptedC = applies.filter((l) =>
            l.op === "apply:C" && l.result === "accepted"
          )
            .length;
          // A and B race for permit 0: whichever shot id lands first owns it;
          // then EVERY delivery of the winner is `accepted` (idempotent) and
          // every delivery of the loser is refused with a permit code.
          const aResults = applies.filter((l) => l.op === "apply:A").map((l) =>
            l.result
          );
          const bResult = applies.find((l) =>
            l.op.startsWith("apply:B")
          )?.result ?? "?";
          const winner = acceptedA > 0 ? "A" : acceptedB > 0 ? "B" : "none";
          ledger.count(`permit0.winner.${winner}`);
          if (winner === "none") {
            ledger.broken(
              `no shot landed on permit 0 (A: ${
                aResults.join(",")
              }; B: ${bResult})`,
            );
          }
          if (winner === "A" && acceptedA !== dupA) {
            ledger.broken(
              `duplicate delivery: ${acceptedA}/${dupA} deliveries of shot A accepted (${
                aResults.join(",")
              })`,
            );
          }
          if (
            winner === "B" &&
            !aResults.every((r) => r.startsWith("access.permit_"))
          ) {
            ledger.broken(
              `A lost permit 0 to B but was not refused with a permit code (${
                aResults.join(",")
              })`,
            );
          }
          if (permitIds[1] && acceptedC !== dupC) {
            ledger.broken(
              `duplicate delivery: ${acceptedC}/${dupC} deliveries of shot C accepted`,
            );
          }
          for (const l of applies) {
            if (l.op === "error") {
              ledger.broken(
                `apply lane errored: ${l.result}`,
              );
            }
          }
          if (acceptedB === 1 && acceptedA > 0) {
            ledger.broken(
              `one permit finalized two different shots (A×${acceptedA}, B → ${bResult})`,
            );
          }
          if (acceptedB === 0 && !bResult.startsWith("access.permit_")) {
            ledger
              .broken(`B refused with unexpected code ${bResult}`);
          }
          ledger.count(`apply.B.${bResult}`);

          const replay = await burst(sql, userId, [
            apply(shotPayload(shotA, permitIds[0]), "replay:A"),
          ]);
          const expectReplay = winner === "A" ? "accepted" : "access.permit_";
          if (!(replay[0]?.result ?? "?").startsWith(expectReplay)) {
            ledger.broken(
              `replay of shot A after commit → ${
                replay[0]?.result
              } (winner ${winner}, expected ${expectReplay}*)`,
            );
          }

          // 3. the table is the truth
          const shots = await sql.unsafe(
            `select id::text as id, result_kind from public.shots where user_id = '${userId}'`,
          );
          const permits = await sql.unsafe(
            `select id::text as id, status, coalesce(outcome, '') as outcome from public.analysis_permits where user_id = '${userId}'`,
          );
          const ledgerRows = await sql.unsafe(
            `select scored_count from public.free_rating_ledger
            where identity_hash = public.free_rating_identity_hash('google', '${sub}')`,
          );
          const expectedShots = new Set<string>();
          if (acceptedA > 0) expectedShots.add(shotA);
          if (acceptedB > 0) expectedShots.add(shotB);
          if (acceptedC > 0) expectedShots.add(shotC);
          const ids = shots.map((s) => String(s.id));
          if (new Set(ids).size !== ids.length) {
            ledger.broken(
              `duplicate rows: ${ids.length} rows for ${new Set(ids).size} ids`,
            );
          }
          if (
            ids.length !== expectedShots.size ||
            ids.some((id) => !expectedShots.has(id))
          ) {
            ledger.broken(
              `rows ${JSON.stringify(ids)} ≠ accepted shots ${
                JSON.stringify([...expectedShots])
              }`,
            );
          }
          const scored = shots.filter((s) => s.result_kind === "scored").length;
          if (scored > 2) {
            ledger.broken(
              `double spend: ${scored} scored rows on a 2-rating free account`,
            );
          }
          const ledgerCount = ledgerRows.length === 1
            ? Number(ledgerRows[0].scored_count)
            : ledgerRows.length === 0
            ? 0
            : NaN;
          if (ledgerCount !== scored) {
            ledger.broken(
              `ledger ${JSON.stringify(ledgerRows)} ≠ ${scored} scored rows`,
            );
          }
          const finalized = permits.filter((p) => p.status === "finalized");
          if (finalized.length !== scored) {
            ledger.broken(
              `${finalized.length} finalized permits for ${scored} scored rows`,
            );
          }
          if (permits.length !== permitIds.length) {
            ledger.broken(
              `${permits.length} permit rows for ${permitIds.length} accepted reservations`,
            );
          }
          ledger.count("shots", ids.length);
          ledger.count("scored", scored);
        },
      );
      assertEquals(table.summary.BROKEN, 0, brokenSeeds(table));
    } finally {
      await sql.end();
    }
  },
});
