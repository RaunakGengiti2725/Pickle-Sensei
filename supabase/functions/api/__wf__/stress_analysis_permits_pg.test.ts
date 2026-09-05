// stress — the Postgres half of POST /v1/analysis-permits under a SEEDED
// concurrency scheduler: public.reserve_analysis_permit(text) (the route's
// only write), racing public.apply_synced_shot(jsonb) and the finalize
// route's `update analysis_permits set status, outcome where id and
// status='reserved'` (issued exactly as PostgREST does, as role
// `authenticated` under RLS), on a disposable postgres:16 with
// shim_auth.sql + every migration applied:
//
//   ./xc_pg_up.sh                                   # prints XC_PG_URL
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     STRESS_PG_ITER=200 deno test -A --no-check --config deno.json stress_analysis_permits_pg.test.ts
//
// Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) the test is `ignore`d, and an
// ignored run is NOT a pass. Never point this at hosted Supabase.
//
// Each iteration draws from its seed: a fresh user (free or premium), 0–2
// phase-1 permits, N independent connections each opening a transaction as
// that user (or a second user replaying the same keys / the first user's
// permit ids), released together from a barrier so the per-user advisory
// xact locks genuinely contend. Ops: reserve (same key, distinct keys, a key
// pool), finalize (PostgREST-shaped update), apply_synced_shot (scored /
// low_confidence), access_state(); optionally one phase-1 permit is aged to
// the 24h boundary so it expires mid-burst (clock skew on the row).
// Invariants after every iteration: one row per (user,key), one permit id
// per key across lanes, no accepted reserve without a row, live reserved +
// lifetime scored ≤ 2 for a free user (no double spend), ledger = scored,
// ≤ 1 shot per permit and permit.outcome = shot.result_kind, no second
// terminal outcome for a settled permit (no lost update), a second user
// never touches the first user's rows, no lane error (no deadlock 40P01),
// and bounded wall time per iteration.
// Replay one iteration: STRESS_PG_REPLAY_SEED=<seed from the JSON table>.
// Output: <STRESS_OUT_DIR>/stress_analysis_permits_pg.json.

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { envInt, histogram, Prng } from "./xc_concurrency_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const STRESS_PG_ITER = envInt("STRESS_PG_ITER", 8);
const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_PG_MAX_LANES = envInt("STRESS_PG_MAX_LANES", 16);
const STRESS_ITER_TIMEOUT_MS = envInt("STRESS_ITER_TIMEOUT_MS", 20_000);
const REPLAY_SEED = envInt("STRESS_PG_REPLAY_SEED", 0);

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

const FINALIZE_OUTCOMES = ["low_confidence", "cancelled", "failed", "unsupported"];

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-analysis-permits/latest/", import.meta.url).pathname;
}

function iterationSeed(base: number, i: number): number {
  let x = (base + Math.imul(i + 1, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0 || 1;
}

function shotPayload(
  id: string,
  analysisPermitId: string,
  resultKind: "scored" | "low_confidence",
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
    overallScore: resultKind === "scored" ? 7 : null,
    confidence: 0.9,
    resultKind,
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
  };
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

async function createUser(sql: Sql, userId: string, sub: string, premium: boolean) {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `delete from auth.users u using auth.identities i
      where i.user_id = u.id and i.provider = 'google' and i.provider_id = '${sub}'`,
  );
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
  if (premium) {
    await sql.unsafe(
      `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
       values ('${userId}', true, 'pickle_sensei_pro_annual', null)`,
    );
  }
}

interface Op {
  lane: number;
  actor: "U" | "V";
  kind: "reserve" | "finalize" | "sync" | "access";
  key?: string;
  permitRef?: number;
  outcome?: string;
  /** V acts on U's permit id (two actors on the same row) */
  foreignPermit?: boolean;
  /** ms the lane waits after the barrier before issuing its statement */
  delayMs: number;
}

interface LaneRow {
  lane: number;
  actor: "U" | "V";
  kind: Op["kind"];
  key?: string;
  permitRef?: number;
  outcome?: string;
  result: string;
  permitId?: string;
  /** rows affected by the PostgREST-shaped finalize update */
  updated?: number;
  error?: string;
  serverStartMs: number;
  serverEndMs: number;
  clientMs: number;
}

interface IterationRow {
  seed: number;
  iteration: number;
  outcome: "HELD" | "BROKEN" | "TIMEOUT";
  features: string[];
  premium: boolean;
  lanes: number;
  lanesOverlappingAnotherLane: number;
  statusHistogram: Record<string, number>;
  durationMs: number;
  violated: string[];
  replay: string;
  detail?: Record<string, unknown>;
}

interface Plan {
  premium: boolean;
  withV: boolean;
  features: string[];
  phase1Keys: string[];
  /** index of the phase-1 permit aged to the 24h boundary, if any */
  agedPermit: number | null;
  /** ms the aged permit sits from the boundary: ≤ 0 already expired at every lane's now() */
  agedOffsetMs: number;
  ops: Op[];
}

function plan(prng: Prng): Plan {
  const features: string[] = [];
  const premium = prng.next() < 0.18;
  if (premium) features.push("premium");
  const withV = prng.next() < 0.25;
  if (withV) features.push("two-actors");
  const settle = prng.next() < 0.5;
  const phase1Keys = settle ? Array.from({ length: prng.int(1, 2) }, () => prng.uuid()) : [];
  if (settle) features.push("call-during-call");
  const agedPermit = settle && prng.next() < 0.3 ? prng.int(0, phase1Keys.length - 1) : null;
  const agedOffsetMs = agedPermit === null ? 0 : prng.int(-250, 250);
  if (agedPermit !== null)
    features.push(agedOffsetMs <= 0 ? "permit-expired" : "permit-at-24h-boundary");
  const poolSize = prng.int(1, 5);
  const pool = Array.from({ length: poolSize }, () => prng.uuid());
  features.push(poolSize === 1 ? "duplicate-calls" : "distinct-keys");
  const lanesU = prng.int(3, withV ? Math.max(3, STRESS_PG_MAX_LANES - 4) : STRESS_PG_MAX_LANES);
  const ops: Op[] = [];
  let lane = 0;
  const push = (op: Omit<Op, "lane">) => ops.push({ lane: lane++, ...op });
  const delay = () => (prng.next() < 0.5 ? 0 : prng.int(0, 12));
  for (let i = 0; i < lanesU; i++) {
    const roll = prng.next();
    if (roll < 0.6 || (phase1Keys.length === 0 && roll < 0.9)) {
      push({ actor: "U", kind: "reserve", key: pool[prng.int(0, poolSize - 1)], delayMs: delay() });
    } else if (roll < 0.75 && phase1Keys.length > 0) {
      push({
        actor: "U",
        kind: "finalize",
        permitRef: prng.int(0, phase1Keys.length - 1),
        outcome: FINALIZE_OUTCOMES[prng.int(0, FINALIZE_OUTCOMES.length - 1)],
        delayMs: delay(),
      });
    } else if (roll < 0.9 && phase1Keys.length > 0) {
      push({
        actor: "U",
        kind: "sync",
        permitRef: prng.int(0, phase1Keys.length - 1),
        outcome: prng.next() < 0.75 ? "scored" : "low_confidence",
        delayMs: delay(),
      });
    } else {
      push({ actor: "U", kind: "access", delayMs: delay() });
    }
  }
  if (withV) {
    const m = prng.int(2, 4);
    for (let i = 0; i < m; i++) {
      if (phase1Keys.length > 0 && prng.next() < 0.4) {
        push({
          actor: "V",
          kind: prng.next() < 0.5 ? "finalize" : "sync",
          permitRef: prng.int(0, phase1Keys.length - 1),
          outcome: "cancelled",
          foreignPermit: true,
          delayMs: delay(),
        });
      } else {
        push({
          actor: "V",
          kind: "reserve",
          key: prng.next() < 0.7 ? pool[prng.int(0, poolSize - 1)] : prng.uuid(),
          delayMs: delay(),
        });
      }
    }
  }
  return { premium, withV, features, phase1Keys, agedPermit, agedOffsetMs, ops };
}

async function serverNowMs(tx: Tx): Promise<number> {
  const r = await tx.unsafe(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`);
  return Number(r[0].t);
}

function overlapCount(rows: LaneRow[]): number {
  let n = 0;
  for (const a of rows) {
    if (
      rows.some(
        (b) => b !== a && a.serverStartMs < b.serverEndMs && b.serverStartMs < a.serverEndMs,
      )
    ) {
      n++;
    }
  }
  return n;
}

async function runIteration(sql: Sql, iteration: number, seed: number): Promise<IterationRow> {
  const prng = new Prng(seed);
  const p = plan(prng);
  const t0 = performance.now();
  const rows: LaneRow[] = [];
  const violated: string[] = [];
  const detail: Record<string, unknown> = {};
  const replay = `XC_PG_URL=<from ./xc_pg_up.sh> STRESS_PG_REPLAY_SEED=${seed} STRESS_PG_MAX_LANES=${STRESS_PG_MAX_LANES} deno test -A --no-check --config deno.json stress_analysis_permits_pg.test.ts`;
  const userU = prng.uuid();
  const userV = prng.uuid();
  const finish = (outcome: IterationRow["outcome"]): IterationRow => ({
    seed,
    iteration,
    outcome,
    features: p.features,
    premium: p.premium,
    lanes: p.ops.length,
    lanesOverlappingAnotherLane: overlapCount(rows),
    statusHistogram: histogram(rows.map((r) => `${r.actor}.${r.kind}:${r.result}`)),
    durationMs: Math.round(performance.now() - t0),
    violated,
    replay,
    detail:
      outcome === "HELD"
        ? undefined
        : { ...detail, users: { U: userU, V: p.withV ? userV : null }, rows },
  });

  const body = async (): Promise<void> => {
    await createUser(sql, userU, `sub-${userU}`, p.premium);
    if (p.withV) await createUser(sql, userV, `sub-${userV}`, false);

    // phase 1 — permits the burst will race on
    const phase1: string[] = [];
    for (const key of p.phase1Keys) {
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, userU);
        const r = await tx.unsafe(
          `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
        );
        if (String(r[0].result) !== "accepted" || !r[0].permit_id) {
          violated.push(`phase1 reserve ${key} → ${r[0].result}`);
          return;
        }
        phase1.push(String(r[0].permit_id));
      });
    }
    if (violated.length > 0) return;
    if (p.agedPermit !== null && phase1[p.agedPermit]) {
      // Owner write: the row sits within ±250ms of the 24h expiry boundary
      // (each lane's now() is its transaction start), so it is either already
      // expired for every lane or crosses the boundary while the burst runs.
      await sql.unsafe(
        `update public.analysis_permits set created_at = now() - interval '24 hours' + interval '${p.agedOffsetMs} milliseconds' where id = '${phase1[p.agedPermit]}'`,
      );
    }
    detail.phase1Permits = phase1;

    // the burst — every lane holds an open transaction before the gate opens
    const b = barrier();
    let ready = 0;
    const shotIds = new Map<number, string>();
    for (const op of p.ops) if (op.kind === "sync") shotIds.set(op.lane, prng.uuid());
    const all = Promise.all(
      p.ops.map((op) =>
        sql
          .begin(async (raw) => {
            const tx = raw as unknown as Tx;
            const userId = op.actor === "U" ? userU : userV;
            await asUser(tx, userId);
            await tx.unsafe(`set local statement_timeout = '${STRESS_ITER_TIMEOUT_MS}ms'`);
            ready += 1;
            await b.gate;
            if (op.delayMs > 0) await new Promise((r) => setTimeout(r, op.delayMs));
            const c0 = performance.now();
            const row: LaneRow = {
              lane: op.lane,
              actor: op.actor,
              kind: op.kind,
              key: op.key,
              permitRef: op.permitRef,
              outcome: op.outcome,
              result: "",
              serverStartMs: 0,
              serverEndMs: 0,
              clientMs: 0,
            };
            try {
              row.serverStartMs = await serverNowMs(tx);
              if (op.kind === "reserve") {
                const r = await tx.unsafe(
                  `select x.result, x.permit_id::text as permit_id, x.permit_status from public.reserve_analysis_permit('${op.key}') x`,
                );
                row.result = String(r[0].result);
                row.permitId = r[0].permit_id ? String(r[0].permit_id) : undefined;
              } else if (op.kind === "finalize") {
                const permitId = phase1[op.permitRef ?? 0];
                // Exactly the finalize route's PostgREST write (index.ts
                // finalizeAnalysisPermitRoute): update only a still-reserved row.
                const r = await tx.unsafe(
                  `update public.analysis_permits set status = 'finalized', outcome = '${op.outcome}'
                  where id = '${permitId}' and user_id = '${userId}' and status = 'reserved'
                  returning id::text as id`,
                );
                row.permitId = permitId;
                row.updated = r.length;
                row.result = r.length === 1 ? "updated" : "no_rows";
              } else if (op.kind === "sync") {
                const permitId = phase1[op.permitRef ?? 0];
                const shot = shotPayload(
                  shotIds.get(op.lane)!,
                  permitId,
                  op.outcome === "low_confidence" ? "low_confidence" : "scored",
                );
                const r = await tx.unsafe(
                  `select public.apply_synced_shot($1::text::jsonb) as result`,
                  [JSON.stringify(shot)],
                );
                row.permitId = permitId;
                row.result = String(r[0].result);
              } else {
                const r = await tx.unsafe(
                  `select premium, scored_count, reserved_count from public.access_state()`,
                );
                const premium = Boolean(r[0].premium);
                const scored = Number(r[0].scored_count);
                const reserved = Number(r[0].reserved_count);
                row.result = `premium=${premium} scored=${scored} reserved=${reserved}`;
                if (op.actor === "U" && premium !== p.premium) {
                  violated.push(`lane ${op.lane}: access_state premium=${premium}`);
                }
                if (!premium && scored + reserved > 2) {
                  violated.push(
                    `lane ${op.lane}: access_state scored=${scored} reserved=${reserved}`,
                  );
                }
              }
              row.serverEndMs = await serverNowMs(tx);
            } catch (error) {
              row.result = "error";
              row.error = String(error);
              throw error;
            } finally {
              row.clientMs = Math.round((performance.now() - c0) * 100) / 100;
              rows.push(row);
            }
          })
          .catch((error: unknown) => {
            violated.push(`lane ${op.lane} ${op.kind}: ${String(error).split("\n")[0]}`);
          }),
      ),
    );
    while (ready < p.ops.length) await new Promise((r) => setTimeout(r, 1));
    b.open();
    await all;
    rows.sort((a, b) => a.lane - b.lane);

    // invariants — owner-role reads after every lane committed
    const permitsU = await sql.unsafe(
      `select id::text as id, idempotency_key as key, status, outcome,
              (created_at > now() - interval '24 hours') as live
         from public.analysis_permits where user_id = '${userU}'`,
    );
    const permitsV = p.withV
      ? await sql.unsafe(
          `select id::text as id, idempotency_key as key, status, outcome,
                (created_at > now() - interval '24 hours') as live
           from public.analysis_permits where user_id = '${userV}'`,
        )
      : [];
    // shots carry no permit column — the permit each shot was written under
    // is known from the lane that synced it.
    const shotRows = await sql.unsafe(
      `select id::text as id, result_kind from public.shots where user_id = '${userU}'`,
    );
    const permitOfShot = new Map<string, string>();
    for (const op of p.ops) {
      if (op.kind === "sync" && op.actor === "U") {
        permitOfShot.set(shotIds.get(op.lane)!, phase1[op.permitRef ?? 0]);
      }
    }
    const shotsU = shotRows.map((s) => ({
      id: String(s.id),
      result_kind: String(s.result_kind),
      permit_id: permitOfShot.get(String(s.id)) ?? "unknown",
    }));
    for (const s of shotsU) {
      if (s.permit_id === "unknown") violated.push(`shot ${s.id} not written by any lane`);
    }
    const shotsV = p.withV
      ? await sql.unsafe(`select id::text as id from public.shots where user_id = '${userV}'`)
      : [];
    const ledger = await sql.unsafe(
      `select l.scored_count::int as n from public.free_rating_ledger l
        where l.identity_hash = public.free_rating_identity_hash('google', 'sub-${userU}')`,
    );
    const scoredU = shotsU.filter((s) => s.result_kind === "scored").length;
    const liveU = permitsU.filter((r) => r.status === "reserved" && r.live).length;
    detail.permitsU = permitsU;
    detail.shotsU = shotsU;
    detail.ledger = ledger.map((l) => Number(l.n));

    for (const [who, permits] of [
      ["U", permitsU],
      ["V", permitsV],
    ] as Array<[string, typeof permitsU]>) {
      if (new Set(permits.map((r) => r.key)).size !== permits.length) {
        violated.push(`${who}: duplicate (user,key) rows`);
      }
      const byKey = new Map<string, Set<string>>();
      for (const r of rows) {
        if (r.actor === who && r.kind === "reserve" && r.result === "accepted") {
          if (!r.permitId) violated.push(`${who} lane ${r.lane}: accepted without permit_id`);
          else {
            byKey.set(r.key!, (byKey.get(r.key!) ?? new Set()).add(r.permitId));
            if (!permits.some((x) => x.id === r.permitId && x.key === r.key)) {
              violated.push(
                `${who} lane ${r.lane}: accepted permit ${r.permitId} has no matching row`,
              );
            }
          }
        }
        if (
          r.actor === who &&
          r.kind === "reserve" &&
          !["accepted", "access.paywall_required"].includes(r.result)
        ) {
          violated.push(`${who} lane ${r.lane}: reserve → ${r.result} ${r.error ?? ""}`);
        }
        if (r.error?.includes("40P01") || r.error?.toLowerCase().includes("deadlock")) {
          violated.push(`${who} lane ${r.lane}: deadlock — ${r.error}`);
        }
      }
      for (const [key, ids] of byKey) {
        if (ids.size !== 1) violated.push(`${who}: key ${key} → ${ids.size} permit ids`);
      }
      const served = new Set(
        rows
          .filter((r) => r.actor === who && r.kind === "reserve" && r.result === "accepted")
          .map((r) => r.permitId),
      );
      for (const r of permits) {
        if (who === "U" && p.phase1Keys.includes(String(r.key))) continue;
        if (!served.has(String(r.id)))
          violated.push(`${who}: row ${r.id} never returned to a lane (lost update)`);
      }
    }
    if (p.premium) {
      for (const r of rows) {
        if (r.actor === "U" && r.kind === "reserve" && r.result === "access.paywall_required") {
          violated.push(`lane ${r.lane}: premium user paywalled`);
        }
      }
    } else {
      if (scoredU + liveU > 2)
        violated.push(`double spend: scored=${scoredU} liveReserved=${liveU}`);
      if (scoredU > 2) violated.push(`lifetime scored=${scoredU}`);
    }
    if ((ledger[0] ? Number(ledger[0].n) : 0) !== scoredU) {
      violated.push(`ledger=${ledger[0]?.n ?? "none"} scored=${scoredU}`);
    }
    if (p.withV) {
      const idsU = new Set(permitsU.map((r) => r.id));
      for (const r of rows) {
        if (r.actor === "V" && r.kind === "reserve" && r.permitId && idsU.has(r.permitId)) {
          violated.push(`V received U's permit ${r.permitId}`);
        }
        if (r.actor === "V" && r.kind === "finalize" && r.updated !== 0) {
          violated.push(`V finalize on U's permit updated ${r.updated} rows`);
        }
        if (r.actor === "V" && r.kind === "sync" && r.result !== "access.permit_not_found") {
          violated.push(`V sync on U's permit → ${r.result}`);
        }
      }
      if (shotsV.length !== 0) violated.push(`V wrote ${shotsV.length} shots`);
      const liveV = permitsV.filter((r) => r.status === "reserved" && r.live).length;
      if (liveV > 2) violated.push(`V liveReserved=${liveV}`);
    }
    for (let i = 0; i < phase1.length; i++) {
      const permitId = phase1[i];
      const row = permitsU.find((r) => r.id === permitId);
      if (!row) {
        violated.push(`phase1 permit ${permitId} vanished`);
        continue;
      }
      const shots = shotsU.filter((s) => s.permit_id === permitId);
      if (shots.length > 1) violated.push(`permit ${permitId}: ${shots.length} shots`);
      if (
        shots.length === 1 &&
        (row.status === "reserved" || row.outcome !== shots[0].result_kind)
      ) {
        violated.push(
          `permit ${permitId}: shot ${shots[0].result_kind} but permit ${row.status}/${row.outcome}`,
        );
      }
      const winners = rows.filter(
        (r) =>
          r.actor === "U" &&
          r.permitId === permitId &&
          ((r.kind === "finalize" && r.updated === 1) ||
            (r.kind === "sync" && r.result === "accepted")),
      );
      const outcomes = new Set(winners.map((w) => w.outcome));
      if (winners.length > 1) {
        violated.push(
          `permit ${permitId}: ${winners.length} terminal writes (${[...outcomes].join(",")})`,
        );
      }
      if (winners.length > 0 && row.status === "reserved") {
        violated.push(`permit ${permitId}: winner recorded but row still reserved`);
      }
      if (winners.length > 0 && !outcomes.has(String(row.outcome))) {
        violated.push(`permit ${permitId}: row outcome ${row.outcome} ≠ accepted ${[...outcomes]}`);
      }
      const expiredLanes = rows.filter(
        (r) => r.permitId === permitId && r.result === "access.permit_expired",
      );
      if (expiredLanes.length > 0) {
        if (i !== p.agedPermit)
          violated.push(`permit ${permitId}: permit_expired on a fresh permit`);
        if (row.status !== "released" || row.outcome !== "expired") {
          violated.push(`permit ${permitId}: expired lane but row ${row.status}/${row.outcome}`);
        }
      }
      if (i === p.agedPermit && p.agedOffsetMs <= 0) {
        // Expired at every lane's now(): no shot may be written under it.
        if (shots.length > 0)
          violated.push(`permit ${permitId}: expired permit produced ${shots.length} shot(s)`);
        for (const r of rows) {
          if (
            r.actor === "U" &&
            r.kind === "sync" &&
            r.permitId === permitId &&
            r.result === "accepted"
          ) {
            violated.push(`lane ${r.lane}: sync accepted on expired permit`);
          }
        }
      }
      if (shots.length === 0 && winners.some((w) => w.kind === "sync")) {
        violated.push(`permit ${permitId}: sync accepted but no shot row`);
      }
    }
    // access_state agrees with the rows once everything committed
    await sql.begin(async (raw) => {
      const tx = raw as unknown as Tx;
      await asUser(tx, userU);
      const r = await tx.unsafe(
        `select premium, scored_count, reserved_count from public.access_state()`,
      );
      const scored = Number(r[0].scored_count);
      const reserved = Number(r[0].reserved_count);
      detail.finalAccess = { premium: Boolean(r[0].premium), scored, reserved };
      if (scored !== scoredU) violated.push(`final access_state scored=${scored} shots=${scoredU}`);
      if (reserved !== liveU)
        violated.push(`final access_state reserved=${reserved} liveRows=${liveU}`);
    });
  };

  let timedOut = false;
  let timer: number | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, STRESS_ITER_TIMEOUT_MS * 2);
  });
  try {
    await Promise.race([body(), timeout]);
  } catch (error) {
    violated.push(`threw: ${String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    violated.push(`iteration exceeded ${STRESS_ITER_TIMEOUT_MS * 2}ms (deadlock / unbounded wait)`);
    return finish("TIMEOUT");
  }
  return finish(violated.length === 0 ? "HELD" : "BROKEN");
}

Deno.test({
  name: "stress permits pg: seeded reserve_analysis_permit concurrency campaign — every iteration HELD",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: STRESS_PG_MAX_LANES + 4 });
    const seeds =
      REPLAY_SEED > 0
        ? [REPLAY_SEED]
        : Array.from({ length: STRESS_PG_ITER }, (_, i) => iterationSeed(STRESS_SEED ^ 0x5047, i));
    const table: IterationRow[] = [];
    const t0 = performance.now();
    try {
      for (let i = 0; i < seeds.length; i++) {
        const row = await runIteration(sql, i, seeds[i]);
        table.push(row);
        if (row.outcome !== "HELD") {
          console.log(`[stress-pg] seed=${row.seed} ${row.outcome}: ${row.violated.join(" | ")}`);
        }
      }
    } finally {
      await sql.end();
    }
    const summary = {
      unit: "route-post-v1-analysis-permits",
      lens: "concurrency",
      plane:
        "linux/docker postgres:16 + shim_auth.sql + every supabase/migrations/*.sql, role authenticated under RLS",
      baseSeed: STRESS_SEED,
      iterations: table.length,
      lanes: table.reduce((n, r) => n + r.lanes, 0),
      lanesOverlappingAnotherLane: table.reduce((n, r) => n + r.lanesOverlappingAnotherLane, 0),
      held: table.filter((r) => r.outcome === "HELD").length,
      broken: table.filter((r) => r.outcome === "BROKEN").map((r) => r.seed),
      timedOut: table.filter((r) => r.outcome === "TIMEOUT").map((r) => r.seed),
      features: histogram(table.flatMap((r) => r.features)),
      statusHistogram: table.reduce<Record<string, number>>((acc, r) => {
        for (const [k, v] of Object.entries(r.statusHistogram)) acc[k] = (acc[k] ?? 0) + v;
        return acc;
      }, {}),
      durationMs: Math.round(performance.now() - t0),
      maxIterationMs: Math.max(...table.map((r) => r.durationMs)),
      heap: Deno.memoryUsage(),
      table,
    };
    const dir = outDir();
    await Deno.mkdir(dir, { recursive: true });
    const path = `${dir}stress_analysis_permits_pg.json`;
    await Deno.writeTextFile(path, JSON.stringify(summary, null, 2));
    console.log(
      `[stress-pg] ${summary.iterations} iterations / ${summary.lanes} lanes (${summary.lanesOverlappingAnotherLane} overlapping) in ${summary.durationMs}ms — held=${summary.held} broken=${summary.broken.length} timedOut=${summary.timedOut.length} → ${path}`,
    );
    console.log(`[stress-pg] features: ${JSON.stringify(summary.features)}`);
    assertEquals(
      [...summary.broken, ...summary.timedOut],
      [],
      `BROKEN/TIMEOUT seeds — replay each with STRESS_PG_REPLAY_SEED=<seed> (see ${path})`,
    );
    assert(summary.iterations === seeds.length, "every planned iteration ran");
  },
});
