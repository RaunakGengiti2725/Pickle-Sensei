/**
 * stress — REAL HANDLER over a REAL POSTGRES for `POST /v1/shots:sync`.
 *
 * Auth stays modelled (FakeSupabase GoTrue), but every PostgREST call the
 * route makes — the batched replay SELECT and `rpc/apply_synced_shot` — is
 * translated into SQL on a disposable postgres:16 with shim_auth.sql + every
 * migration applied (./xc_pg_up.sh), executed in its own transaction as role
 * `authenticated` with the bearer's `sub`, exactly as PostgREST would. Lanes
 * fired with Promise.all therefore contend on the RPC's per-user advisory
 * lock for real.
 *
 *   ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json stress_shots_sync_pg.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 *
 * P0 properties under test: duplicate delivery (sequential, concurrent, and
 * after a response lost post-commit) yields exactly ONE row per shot and
 * consumes each permit once; the free-rating allowance cannot be double
 * spent through any of those paths.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  type BatchShot,
  drive,
  jwtSub,
  latencyStats,
  loadStressHarness,
  mintUser,
  Prng,
  STRESS_SEED,
  type StressHarness,
  type StressUser,
  syncRequest,
  syncShotPayload,
  writeJson,
} from "./stress_shots_sync_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const LANES = (() => {
  const n = Number(Deno.env.get("STRESS_PG_LANES") ?? "8");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
})();
const PG_LOAD_REQ = (() => {
  const n = Number(Deno.env.get("STRESS_PG_LOAD_REQ") ?? "200");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
})();

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

let sql: Sql | null = null;
let harness: StressHarness | null = null;

/** PostgREST error envelope + status for a SQLSTATE (PostgREST maps 42501 to
 * 403 and most raised errors to 400; postgrest-js only distinguishes 2xx). */
function pgError(e: unknown): Response {
  const err = e as {
    code?: string;
    message?: string;
    detail?: string;
    hint?: string;
  };
  const code = err.code ?? "XX000";
  const status = code === "42501" ? 403 : code.startsWith("PGRST") ? 404 : 400;
  return new Response(
    JSON.stringify({
      code,
      message: err.message ?? String(e),
      details: err.detail ?? null,
      hint: err.hint ?? null,
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

/** The PostgREST shim: SELECT id FROM shots WHERE user_id = eq. AND id IN (...),
 * and POST rpc/apply_synced_shot {shot} → select public.apply_synced_shot($1). */
async function restBackend(
  request: Request,
  _raw: string,
  body: unknown,
): Promise<Response | null> {
  const db = sql!;
  const sub = jwtSub(
    (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""),
  );
  if (!sub) {
    return new Response(JSON.stringify({ message: "JWT missing sub" }), {
      status: 401,
    });
  }
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname.endsWith("/rest/v1/shots")) {
    const userEq = url.searchParams.get("user_id") ?? "";
    const idIn = url.searchParams.get("id") ?? "";
    if (
      !userEq.startsWith("eq.") || !idIn.startsWith("in.(") ||
      !idIn.endsWith(")")
    ) {
      return new Response(
        JSON.stringify({ message: `unsupported filter ${url.search}` }),
        { status: 400 },
      );
    }
    const userId = userEq.slice(3);
    const ids = idIn.slice(4, -1).split(",").map((s) => s.replace(/^"|"$/g, ""))
      .filter(Boolean);
    try {
      let rows: Array<{ id: string }> = [];
      await db.begin(async (tx) => {
        await asUser(tx as unknown as Tx, sub);
        rows = await (tx as unknown as Tx).unsafe(
          `select id::text as id from public.shots where user_id = $1::uuid and id = any($2::uuid[])`,
          [userId, ids],
        ) as unknown as Array<{ id: string }>;
      });
      return new Response(JSON.stringify(rows.map((r) => ({ id: r.id }))), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return pgError(e);
    }
  }
  if (
    request.method === "POST" &&
    url.pathname.endsWith("/rest/v1/rpc/apply_synced_shot")
  ) {
    const shot = body && typeof body === "object"
      ? (body as { shot?: unknown }).shot
      : undefined;
    try {
      let result = "";
      await db.begin(async (tx) => {
        await asUser(tx as unknown as Tx, sub);
        const r = await (tx as unknown as Tx).unsafe(
          `select public.apply_synced_shot($1::text::jsonb) as result`,
          [JSON.stringify(shot ?? null)],
        ) as unknown as Array<{ result: string }>;
        result = String(r[0].result);
      });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return pgError(e);
    }
  }
  return null;
}

async function h(): Promise<StressHarness> {
  if (harness) return harness;
  sql = postgres(PG_URL, { max: Math.max(LANES * 2, 16), onnotice: () => {} });
  harness = await loadStressHarness({ redis: false });
  harness.restBackend = restBackend;
  return harness;
}

/** A PG user matching a fake-GoTrue user (same uuid), with a Google identity
 * so the free-rating ledger has a subject; premium via billing_entitlements. */
async function pgUser(
  H: StressHarness,
  prng: Prng,
  premium: boolean,
): Promise<StressUser> {
  const user = mintUser(H, prng, { premium });
  const db = sql!;
  const subject = `stress-${user.id}`;
  await db.unsafe(`delete from auth.users where id = '${user.id}'`);
  await db.unsafe(
    `delete from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', '${subject}')`,
  );
  await db.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${user.id}', '${user.id}@example.com', '{"provider":"google"}')`,
  );
  await db.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', '${subject}', '${user.id}', '{"sub":"${subject}"}')`,
  );
  if (premium) {
    await db.unsafe(
      `insert into public.billing_entitlements (user_id, premium, product_key) values ('${user.id}', true, 'pickle_sensei_pro_yearly')
       on conflict (user_id) do update set premium = true`,
    );
  }
  return user;
}

/** Reserve a permit through the REAL RPC as the user. */
async function reserve(
  userId: string,
  key: string,
): Promise<{ result: string; permitId: string | null }> {
  let out = { result: "", permitId: null as string | null };
  await sql!.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId);
    const r = await (tx as unknown as Tx).unsafe(
      `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
    ) as unknown as Array<{ result: string; permit_id: string | null }>;
    out = {
      result: String(r[0].result),
      permitId: r[0].permit_id ? String(r[0].permit_id) : null,
    };
  });
  return out;
}

async function state(userId: string) {
  const db = sql!;
  const shots = await db.unsafe(
    `select count(*)::int as n, count(*) filter (where result_kind = 'scored')::int as scored from public.shots where user_id = '${userId}'`,
  ) as unknown as Array<{ n: number; scored: number }>;
  const permits = await db.unsafe(
    `select status, coalesce(outcome, '') as outcome, count(*)::int as n from public.analysis_permits where user_id = '${userId}' group by 1, 2 order by 1, 2`,
  ) as unknown as Array<{ status: string; outcome: string; n: number }>;
  const ledger = await db.unsafe(
    `select l.scored_count::int as c from public.free_rating_ledger l
       join auth.identities i on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
      where i.user_id = '${userId}'`,
  ) as unknown as Array<{ c: number }>;
  let access = { premium: false, scored_count: 0, reserved_count: 0 };
  await db.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId);
    const r = await (tx as unknown as Tx).unsafe(
      `select premium, scored_count::int as scored_count, reserved_count::int as reserved_count from public.access_state()`,
    ) as unknown as Array<
      { premium: boolean; scored_count: number; reserved_count: number }
    >;
    access = {
      premium: Boolean(r[0].premium),
      scored_count: Number(r[0].scored_count),
      reserved_count: Number(r[0].reserved_count),
    };
  });
  return {
    shots: Number(shots[0].n),
    scoredShots: Number(shots[0].scored),
    permits: permits.map((p) => `${p.status}/${p.outcome}=${p.n}`),
    ledger: ledger.map((l) => Number(l.c)),
    access,
  };
}

async function rowsFor(ids: string[]): Promise<Record<string, number>> {
  const r = await sql!.unsafe(
    `select id::text as id, count(*)::int as n from public.shots where id = any($1::uuid[]) group by 1`,
    [ids],
  ) as unknown as Array<{ id: string; n: number }>;
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = 0;
  for (const row of r) out[row.id] = Number(row.n);
  return out;
}

function batchFor(
  prng: Prng,
  userPermits: string[],
  overrides: (i: number) => Record<string, unknown> = () => ({}),
): BatchShot[] {
  return userPermits.map((permitId, i) => {
    const id = prng.uuid();
    return {
      id,
      permitId,
      payload: syncShotPayload(id, permitId, overrides(i)),
    };
  });
}

interface Lane {
  lane: number;
  status: number;
  acceptedIds: string[];
  rejected: Array<{ id: string; code: string }>;
  latencyMs: number;
}

/** Fire the same (or per-lane) request N times concurrently through the
 * handler; the PostgREST shim runs each SQL call in its own transaction. */
async function lanes(
  H: StressHarness,
  n: number,
  make: (lane: number) => Request,
): Promise<Lane[]> {
  return await Promise.all(
    Array.from({ length: n }, async (_, lane) => {
      const t = performance.now();
      const res = await H.handler(make(lane));
      const text = await res.text();
      let body: {
        acceptedIds?: string[];
        rejected?: Array<{ id: string; code: string }>;
      } = {};
      try {
        body = JSON.parse(text);
      } catch { /* non-JSON */ }
      return {
        lane,
        status: res.status,
        acceptedIds: body.acceptedIds ?? [],
        rejected: (body.rejected ?? []).map((r) => ({
          id: r.id,
          code: r.code,
        })),
        latencyMs: Math.round((performance.now() - t) * 100) / 100,
      };
    }),
  );
}

interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
}
const reports: Array<Record<string, unknown>> = [];
let scenariosExecuted = 0;

function finish(
  name: string,
  seed: number,
  invariants: Invariant[],
  extra: Record<string, unknown>,
) {
  const report = {
    scenario: name,
    seed,
    held: invariants.every((i) => i.holds),
    invariants,
    replay: `XC_PG_URL=${
      PG_URL || "<see ./xc_pg_up.sh>"
    } STRESS_SEED=${STRESS_SEED} deno test -A --no-check --config deno.json --filter "${name}" stress_shots_sync_pg.test.ts`,
    ...extra,
  };
  reports.push(report);
  const broken = invariants.filter((i) => !i.holds);
  assert(
    broken.length === 0,
    `${name} seed=${seed}: ${
      broken.map((i) => `${i.name} [${i.detail}]`).join("; ")
    }`,
  );
}

const seedFor = (k: number) => (STRESS_SEED + 11_000_000 + k * 7919) >>> 0;

Deno.test({
  name:
    "stress pg PGS1: duplicate delivery, sequential ×3 — one row per shot, replays via SELECT (0 RPC), permits finalized once",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const H = await h();
    const seed = seedFor(1);
    const prng = new Prng(seed);
    H.reset(seed);
    const user = await pgUser(H, prng, true);
    const permits: string[] = [];
    for (let i = 0; i < 3; i++) {
      permits.push((await reserve(user.id, `k${i}-${seed}`)).permitId!);
    }
    const batch = batchFor(prng, permits);
    const inv: Invariant[] = [];
    const deliveries = [];
    for (let d = 0; d < 3; d++) {
      const out = await drive(H, `pgs1:${d}`, syncRequest(user, batch));
      scenariosExecuted += 1;
      deliveries.push({
        d,
        status: out.status,
        accepted: out.acceptedIds.length,
        rejected: out.rejected,
        roundTrips: out.roundTrips,
        latencyMs: out.latencyMs,
      });
      inv.push({
        name: `delivery ${d}: 200 + all accepted`,
        holds: out.status === 200 && out.acceptedIds.length === 3,
        detail: `${out.status} ${JSON.stringify(out.rejected)}`,
      });
      inv.push({
        name: `delivery ${d}: ${
          d === 0 ? "3 RPC" : "0 RPC (replay via the batched SELECT)"
        }`,
        holds: out.roundTrips["rest.rpc"] === (d === 0 ? 3 : 0) &&
          out.roundTrips["rest.select"] === 1,
        detail: JSON.stringify(out.roundTrips),
      });
    }
    const rows = await rowsFor(batch.map((s) => s.id));
    const st = await state(user.id);
    inv.push({
      name: "exactly one row per shot",
      holds: Object.values(rows).every((n) => n === 1),
      detail: JSON.stringify(rows),
    });
    inv.push({
      name: "3 permits finalized/scored, no others",
      holds: st.permits.join() === "finalized/scored=3",
      detail: st.permits.join(),
    });
    inv.push({
      name: "scored_count = 3 (premium: no cap)",
      holds: st.access.scored_count === 3 && st.access.premium,
      detail: JSON.stringify(st.access),
    });
    finish("PGS1", seed, inv, { deliveries, rows, state: st });
  },
});

Deno.test({
  name:
    `stress pg PGS2: duplicate delivery, ${LANES} concurrent copies of one 5-shot batch — every copy accepted, one row per shot, permits finalized once`,
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const H = await h();
    const seed = seedFor(2);
    const prng = new Prng(seed);
    H.reset(seed);
    const user = await pgUser(H, prng, true);
    await drive(H, "pgs2:warm", syncRequest(user, { shots: [] }));
    const permits: string[] = [];
    for (let i = 0; i < 5; i++) {
      permits.push((await reserve(user.id, `k${i}-${seed}`)).permitId!);
    }
    const batch = batchFor(prng, permits);
    const out = await lanes(H, LANES, () => syncRequest(user, batch));
    scenariosExecuted += LANES;
    const rows = await rowsFor(batch.map((s) => s.id));
    const st = await state(user.id);
    const inv: Invariant[] = [
      {
        name: "every lane 200",
        holds: out.every((l) => l.status === 200),
        detail: out.map((l) => l.status).join(","),
      },
      {
        name:
          "every lane acknowledged every shot (loser of the race replays as accepted)",
        holds: out.every((l) =>
          l.acceptedIds.length === 5 && l.rejected.length === 0
        ),
        detail: out.map((l) =>
          `${l.acceptedIds.length}/${l.rejected.map((r) => r.code).join("|")}`
        ).join(" "),
      },
      {
        name: "exactly one row per shot",
        holds: Object.values(rows).every((n) => n === 1),
        detail: JSON.stringify(rows),
      },
      {
        name: "5 permits finalized/scored, no others",
        holds: st.permits.join() === "finalized/scored=5",
        detail: st.permits.join(),
      },
      {
        name: "scored_count = 5",
        holds: st.access.scored_count === 5,
        detail: JSON.stringify(st.access),
      },
    ];
    finish("PGS2", seed, inv, {
      lanes: out,
      rows,
      state: st,
      latency: latencyStats(out.map((l) => l.latencyMs)),
    });
  },
});

Deno.test({
  name:
    `stress pg PGS3: FREE user, both permits, ${LANES} concurrent duplicate deliveries — exactly 2 ratings spent, ledger 2, third reservation paywalled`,
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const H = await h();
    const seed = seedFor(3);
    const prng = new Prng(seed);
    H.reset(seed);
    const user = await pgUser(H, prng, false);
    await drive(H, "pgs3:warm", syncRequest(user, { shots: [] }));
    const r1 = await reserve(user.id, `a-${seed}`);
    const r2 = await reserve(user.id, `b-${seed}`);
    const r3 = await reserve(user.id, `c-${seed}`);
    const batch = batchFor(prng, [r1.permitId!, r2.permitId!]);
    const out = await lanes(H, LANES, () => syncRequest(user, batch));
    scenariosExecuted += LANES;
    // Re-use permit A for a NEW shot id (a device replaying with a fresh id).
    const reuse = batchFor(prng, [r1.permitId!]);
    const reused = await drive(H, "pgs3:reuse", syncRequest(user, reuse));
    scenariosExecuted += 1;
    const r4 = await reserve(user.id, `d-${seed}`);
    const rows = await rowsFor([...batch.map((s) => s.id), reuse[0].id]);
    const st = await state(user.id);
    const inv: Invariant[] = [
      {
        name: "2 permits reserved, the third refused (paywall) before any sync",
        holds: r1.result === "accepted" && r2.result === "accepted" &&
          r3.result === "access.paywall_required",
        detail: `${r1.result},${r2.result},${r3.result}`,
      },
      {
        name: "every lane 200 and acknowledged both shots",
        holds: out.every((l) => l.status === 200 && l.acceptedIds.length === 2),
        detail: out.map((l) =>
          `${l.status}:${l.acceptedIds.length}/${
            l.rejected.map((r) => r.code).join("|")
          }`
        ).join(" "),
      },
      {
        name: "exactly one row per shot, none for the permit re-use",
        holds: rows[batch[0].id] === 1 && rows[batch[1].id] === 1 &&
          rows[reuse[0].id] === 0,
        detail: JSON.stringify(rows),
      },
      {
        name:
          "permit re-use with a new shot id → access.permit_not_reserved (permanent, no write)",
        holds: reused.status === 200 &&
          reused.rejected[0]?.code === "access.permit_not_reserved",
        detail: JSON.stringify(reused.rejected),
      },
      {
        name: "scored_count = 2 and ledger = 2 after 8 copies",
        holds: st.access.scored_count === 2 && st.ledger.join() === "2",
        detail: JSON.stringify({ access: st.access, ledger: st.ledger }),
      },
      {
        name: "a further reservation is paywalled",
        holds: r4.result === "access.paywall_required",
        detail: r4.result,
      },
      {
        name: "2 permits finalized/scored, none reserved",
        holds: st.permits.join() === "finalized/scored=2",
        detail: st.permits.join(),
      },
    ];
    finish("PGS3", seed, inv, {
      lanes: out,
      reused: reused.rejected,
      reservations: [r1.result, r2.result, r3.result, r4.result],
      rows,
      state: st,
    });
  },
});

Deno.test({
  name:
    `stress pg PGS4: one permit, ${LANES} concurrent DISTINCT shot ids — exactly one accepted, the rest access.permit_not_reserved, one rating spent`,
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const H = await h();
    const seed = seedFor(4);
    const prng = new Prng(seed);
    H.reset(seed);
    const user = await pgUser(H, prng, false);
    await drive(H, "pgs4:warm", syncRequest(user, { shots: [] }));
    const permit = (await reserve(user.id, `p-${seed}`)).permitId!;
    const shots = Array.from(
      { length: LANES },
      () => batchFor(prng, [permit])[0],
    );
    const out = await lanes(
      H,
      LANES,
      (lane) => syncRequest(user, [shots[lane]]),
    );
    scenariosExecuted += LANES;
    const rows = await rowsFor(shots.map((s) => s.id));
    const st = await state(user.id);
    const accepted = out.filter((l) => l.acceptedIds.length === 1).length;
    const codes = out.flatMap((l) => l.rejected.map((r) => r.code));
    const inv: Invariant[] = [
      {
        name: "every lane 200",
        holds: out.every((l) => l.status === 200),
        detail: out.map((l) => l.status).join(","),
      },
      {
        name: "exactly one lane accepted",
        holds: accepted === 1,
        detail: `accepted=${accepted}`,
      },
      {
        name:
          "losers: access.permit_not_reserved (permanent — the client drops the row)",
        holds: codes.length === LANES - 1 &&
          codes.every((c) => c === "access.permit_not_reserved"),
        detail: codes.join(","),
      },
      {
        name: "exactly one shot row in total",
        holds: Object.values(rows).reduce((a, b) => a + b, 0) === 1,
        detail: JSON.stringify(rows),
      },
      {
        name: "scored_count = 1, ledger = 1, permit finalized once",
        holds: st.access.scored_count === 1 && st.ledger.join() === "1" &&
          st.permits.join() === "finalized/scored=1",
        detail: JSON.stringify(st),
      },
    ];
    finish("PGS4", seed, inv, { lanes: out, rows, state: st });
  },
});

Deno.test({
  name:
    "stress pg PGS5: RPC committed but the response was lost — retry replays as accepted, one row, one rating, second permit untouched",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const H = await h();
    const seed = seedFor(5);
    const prng = new Prng(seed);
    H.reset(seed);
    const user = await pgUser(H, prng, false);
    await drive(H, "pgs5:warm", syncRequest(user, { shots: [] }));
    const a = (await reserve(user.id, `a-${seed}`)).permitId!;
    // permit B stays reserved throughout — the invariant below checks it.
    await reserve(user.id, `b-${seed}`);
    const batch = batchFor(prng, [a]);
    H.setFault((
      call,
    ) => (call.upstream === "rest.rpc" && call.nth === 0
      ? {
        kind: "after-commit",
        then: { kind: "throw", message: "connection reset" },
      }
      : null)
    );
    const lost = await drive(H, "pgs5:lost", syncRequest(user, batch));
    H.setFault(null);
    const retry = await drive(H, "pgs5:retry", syncRequest(user, batch));
    scenariosExecuted += 2;
    const rows = await rowsFor([batch[0].id]);
    const st = await state(user.id);
    const inv: Invariant[] = [
      {
        name:
          "lost response → 200 with shot.write_failed (transient: the outbox keeps the row)",
        holds: lost.status === 200 &&
          lost.rejected[0]?.code === "shot.write_failed",
        detail: `${lost.status} ${JSON.stringify(lost.rejected)}`,
      },
      {
        name: "retry → accepted through the replay SELECT (0 RPC)",
        holds: retry.status === 200 && retry.acceptedIds.length === 1 &&
          retry.roundTrips["rest.rpc"] === 0,
        detail: `${retry.status} ${JSON.stringify(retry.roundTrips)}`,
      },
      {
        name: "exactly one row",
        holds: rows[batch[0].id] === 1,
        detail: JSON.stringify(rows),
      },
      {
        name: "one rating spent, permit B still reserved",
        holds: st.access.scored_count === 1 && st.access.reserved_count === 1 &&
          st.permits.join() === "finalized/scored=1,reserved/=1",
        detail: JSON.stringify(st),
      },
    ];
    finish("PGS5", seed, inv, {
      lost: { status: lost.status, rejected: lost.rejected },
      retry: { status: retry.status, roundTrips: retry.roundTrips },
      rows,
      state: st,
    });
  },
});

Deno.test({
  name:
    "stress pg PGS6: foreign permit + foreign shot id — RLS hides the permit (access.permit_not_found), shot id owned by another user → shot.id_conflict; nothing written",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const H = await h();
    const seed = seedFor(6);
    const prng = new Prng(seed);
    H.reset(seed);
    const owner = await pgUser(H, prng, true);
    const attacker = await pgUser(H, prng, true);
    const ownerPermit = (await reserve(owner.id, `o-${seed}`)).permitId!;
    const ownerBatch = batchFor(prng, [ownerPermit]);
    const committed = await drive(
      H,
      "pgs6:owner",
      syncRequest(owner, ownerBatch),
    );
    const attackerPermit = (await reserve(attacker.id, `x-${seed}`)).permitId!;
    // (a) attacker's own shot id bound to the owner's permit; (b) the owner's
    // shot id re-sent under the attacker's own valid permit.
    const foreignPermit = batchFor(prng, [ownerPermit]);
    const stolenId: BatchShot = {
      id: ownerBatch[0].id,
      permitId: attackerPermit,
      payload: syncShotPayload(ownerBatch[0].id, attackerPermit),
    };
    const out = await drive(
      H,
      "pgs6:attacker",
      syncRequest(attacker, [foreignPermit[0], stolenId]),
    );
    scenariosExecuted += 2;
    const rows = await rowsFor([ownerBatch[0].id, foreignPermit[0].id]);
    const ownerRow = await sql!.unsafe(
      `select user_id::text as u from public.shots where id = '${
        ownerBatch[0].id
      }'`,
    ) as unknown as Array<{ u: string }>;
    const st = await state(attacker.id);
    const codes = Object.fromEntries(out.rejected.map((r) => [r.id, r.code]));
    const inv: Invariant[] = [
      {
        name: "owner's sync accepted",
        holds: committed.status === 200 && committed.acceptedIds.length === 1,
        detail: String(committed.status),
      },
      {
        name: "foreign permit → access.permit_not_found",
        holds: codes[foreignPermit[0].id] === "access.permit_not_found",
        detail: JSON.stringify(codes),
      },
      {
        name: "foreign shot id → shot.id_conflict",
        holds: codes[ownerBatch[0].id] === "shot.id_conflict",
        detail: JSON.stringify(codes),
      },
      {
        name: "no row written for the attacker; owner's row untouched",
        holds: rows[foreignPermit[0].id] === 0 &&
          rows[ownerBatch[0].id] === 1 && ownerRow[0]?.u === owner.id,
        detail: JSON.stringify({ rows, ownerRow }),
      },
      {
        name:
          "attacker's permit still reserved (not consumed by a refused write)",
        holds: st.permits.join() === "reserved/=1",
        detail: st.permits.join(),
      },
    ];
    finish("PGS6", seed, inv, {
      attacker: { status: out.status, rejected: out.rejected },
      rows,
      state: st,
    });
  },
});

Deno.test({
  name:
    "stress pg PGS7: low_confidence shot releases its permit without spending a rating — a further reservation is granted",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const H = await h();
    const seed = seedFor(7);
    const prng = new Prng(seed);
    H.reset(seed);
    const user = await pgUser(H, prng, false);
    const a = (await reserve(user.id, `a-${seed}`)).permitId!;
    const b = (await reserve(user.id, `b-${seed}`)).permitId!;
    const batch = batchFor(
      prng,
      [a, b],
      (
        i,
      ) => (i === 1
        ? { resultKind: "low_confidence", overallScore: null, confidence: 0.2 }
        : {}),
    );
    const out = await drive(H, "pgs7", syncRequest(user, batch));
    const again = await drive(H, "pgs7:again", syncRequest(user, batch));
    scenariosExecuted += 2;
    const st = await state(user.id);
    const rows = await rowsFor(batch.map((s) => s.id));
    const r3 = await reserve(user.id, `c-${seed}`);
    const inv: Invariant[] = [
      {
        name: "both accepted",
        holds: out.status === 200 && out.acceptedIds.length === 2,
        detail: `${out.status} ${JSON.stringify(out.rejected)}`,
      },
      {
        name: "duplicate delivery of the mixed batch → both accepted, 0 RPC",
        holds: again.status === 200 && again.acceptedIds.length === 2 &&
          again.roundTrips["rest.rpc"] === 0,
        detail: JSON.stringify(again.roundTrips),
      },
      {
        name: "one row each",
        holds: Object.values(rows).every((n) => n === 1),
        detail: JSON.stringify(rows),
      },
      {
        name:
          "scored_count = 1; the abstention's permit released/low_confidence",
        holds: st.access.scored_count === 1 &&
          st.permits.join() === "finalized/scored=1,released/low_confidence=1",
        detail: JSON.stringify(st),
      },
      {
        name: "one rating left: a further reservation is accepted",
        holds: r3.result === "accepted",
        detail: r3.result,
      },
    ];
    finish("PGS7", seed, inv, {
      out: { status: out.status, rejected: out.rejected },
      rows,
      state: st,
      thirdReservation: r3.result,
    });
  },
});

Deno.test({
  name:
    `stress pg load: ${PG_LOAD_REQ} sequential route requests over real Postgres — p50/p95 by batch size`,
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const H = await h();
    const seed = seedFor(8);
    const prng = new Prng(seed);
    H.reset(seed);
    const users: StressUser[] = [];
    for (let i = 0; i < Math.max(4, Math.ceil(PG_LOAD_REQ / 25)); i++) {
      const u = await pgUser(H, prng, true);
      await drive(H, `pgload:warm:${i}`, syncRequest(u, { shots: [] }));
      users.push(u);
    }
    const perUser = new Array(users.length).fill(0);
    const rows: Array<
      {
        i: number;
        batch: number;
        status: number;
        accepted: number;
        latencyMs: number;
        rpc: number;
      }
    > = [];
    const allIds: string[] = [];
    for (let i = 0; i < PG_LOAD_REQ; i++) {
      let u = prng.int(0, users.length - 1);
      for (let tries = 0; perUser[u] >= 25 && tries < users.length; tries++) {
        u = (u + 1) % users.length;
      }
      perUser[u] += 1;
      const user = users[u];
      const r = prng.int(0, 99);
      const n = r < 60 ? 1 : r < 90 ? prng.int(2, 5) : prng.int(6, 20);
      const permits: string[] = [];
      for (let k = 0; k < n; k++) {
        permits.push((await reserve(user.id, `l${i}-${k}-${seed}`)).permitId!);
      }
      const batch = batchFor(prng, permits);
      allIds.push(...batch.map((s) => s.id));
      const out = await drive(H, `pgload:${i}`, syncRequest(user, batch));
      rows.push({
        i,
        batch: n,
        status: out.status,
        accepted: out.acceptedIds.length,
        latencyMs: out.latencyMs,
        rpc: out.roundTrips["rest.rpc"],
      });
      assert(
        out.status === 200 && out.acceptedIds.length === n,
        `request ${i}: ${out.status} ${JSON.stringify(out.rejected)}`,
      );
    }
    scenariosExecuted += rows.length;
    const dup = Object.values(await rowsFor(allIds)).filter((n) =>
      n !== 1
    ).length;
    const byBatch: Record<string, number[]> = {};
    for (const r of rows) {
      (byBatch[r.batch === 1 ? "1" : r.batch <= 5 ? "2-5" : "6-20"] ??= [])
        .push(r.latencyMs);
    }
    const report = {
      scenario: "pg-load",
      seed,
      requests: rows.length,
      latencyMs: latencyStats(rows.map((r) => r.latencyMs)),
      byBatch: Object.fromEntries(
        Object.entries(byBatch).map(([k, v]) => [k, latencyStats(v)]),
      ),
      rpcPerRequest: latencyStats(rows.map((r) => r.rpc)),
      shotsWithRowCountNot1: dup,
      held: dup === 0,
      rows,
    };
    reports.push(report);
    console.log(
      `[stress] pg-load: n=${rows.length} p50=${report.latencyMs.p50}ms p95=${report.latencyMs.p95}ms rpc/req mean=${report.rpcPerRequest.mean}`,
    );
    assert(dup === 0, `${dup} shots without exactly one row`);
  },
});

Deno.test({
  name: "stress pg: write evidence JSON",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const path = await writeJson("pg_route_real_db", {
      suite: "pg.route-over-real-postgres",
      pgUrlHost: PG_URL.replace(/\/\/.*@/, "//<redacted>@"),
      lanes: LANES,
      scenariosExecuted,
      held: reports.filter((r) => r.held).length,
      broken: reports.filter((r) => !r.held).map((r) => r.scenario),
      reports,
    });
    console.log(
      `[stress] pg: ${reports.length} scenarios (${scenariosExecuted} requests) → ${path}`,
    );
    assertEquals(reports.filter((r) => !r.held).length, 0);
    await sql?.end({ timeout: 5 });
  },
});
