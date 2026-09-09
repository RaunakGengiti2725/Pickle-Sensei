/**
 * W04-01 concurrency regression — REAL Postgres races against migration
 * 20260908160000_offline_device_grants.sql (round 7). Pins the two adversary
 * breaks of round 6 and the conservation/reentrancy shapes around them:
 * register_offline_device() must be idempotent under an overlapping double
 * submit (per-user advisory lock before the lookup), and one ticket must end
 * in exactly ONE terminal event even when recovered sibling accounts — two
 * different auth.uid()s owning the ticket through their identity hashes —
 * settle it concurrently (per-ticket advisory lock + the ledger's
 * one-terminal unique index).
 *
 * Same harness as xc_pg_permit_terminal_adversary.test.ts: a disposable
 * postgres:16 with shim_auth.sql + every migration applied (./xc_pg_up.sh),
 * every client statement as role `authenticated` with a JWT sub AND a live
 * auth.sessions row named in request.jwt.claims (the W04-01 RPCs require
 * api_private.is_active_session()), nothing mocked. Owner-role statements
 * stand in for Supabase Auth / the service role and are labelled as such.
 *
 *   ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json w04_01_offline_grants_concurrency.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
 * ignored run is NOT a pass.
 *
 * Interleavings are DETERMINISTIC where the attack needs one: lane A runs its
 * RPC inside an open transaction and parks before COMMIT; lane B then runs its
 * RPC on an independent connection (it cannot see A's uncommitted rows and, if
 * it blocks on a unique index, resumes only when A commits). Bursts use a
 * barrier so N connections genuinely contend on the per-user advisory lock.
 *
 * Cases (categories from the W04-01 brief):
 *   ATK-01 concurrency/double submit — register_offline_device() twice for the
 *          same (user, installation key) in overlapping transactions.
 *   ATK-02 concurrency — 16 issue_offline_grant() lanes on one installation.
 *   ATK-03 concurrency + conservation — offline allocation across 6 devices
 *          racing reserve_analysis_permit() on 6 keys, one free identity.
 *   ATK-04 reentrancy/replay — 16 consume lanes on one ticket (distinct shot
 *          ids), then 8 consume + 8 release lanes on one ticket.
 *   ATK-05 replay + duplicate identities — original-installation recovery
 *          after account deletion with the two sign-in identities landing on
 *          two new accounts: release (account B) overlapping consume (account C).
 *   ATK-06 duplicate identities — the same split, consume vs consume.
 *   ATK-07 process death / restart — the reply is lost after commit and the
 *          device replays (ticket, shot); a malformed detail row inside the
 *          settlement must roll the whole settlement back.
 */
import postgres, { type JSONValue } from "postgres";
import { assert, assertEquals } from "@std/assert";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

// Distinct from every other __wf__ suite's users so the files can share one
// disposable DB in a single `deno task test`, and distinct per RUN: the
// ledger is append-only for every role (a fixture cannot scrub it) and, like
// production, never reuses an account id, an identity or an installation.
const RUN = crypto.randomUUID().slice(0, 8);
const U = (n: number): string => `0000000a-a704-4000-8000-${RUN}00${String(n).padStart(2, "0")}`;
const SESSION = (n: number): string =>
  `0000000a-a704-4000-8000-${RUN}0a${String(n).padStart(2, "0")}`;
const KEY = (name: string): string => `${name}-${RUN}`;
const SUB = (name: string): string => `w04-cc-${name}-${RUN}`;

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
  overrides: Record<string, JSONValue> = {},
): Record<string, JSONValue> {
  return {
    id,
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
    ...overrides,
  };
}

let shotSeq = 0;
function shotId(): string {
  shotSeq += 1;
  return `0000000a-a704-4000-8000-${RUN}5${String(shotSeq).padStart(3, "0")}`;
}

type Identity = { provider: "google" | "apple"; sub: string };

/** Owner role stands in for Supabase Auth: (re)create a user with its
 * sign-in identities and one live session. */
async function createUser(sql: Sql, n: number, identities: Identity[]): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${U(n)}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${U(n)}', 'w04-cc-${n}@example.com', '{"provider":"${identities[0].provider}"}')`,
  );
  for (const identity of identities) {
    await sql.unsafe(
      `insert into auth.identities (provider, provider_id, user_id, identity_data)
       values ('${identity.provider}', '${identity.sub}', '${U(n)}', '{"sub":"${identity.sub}"}')`,
    );
  }
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${SESSION(n)}', '${U(n)}')`);
}

/** Owner role stands in for account deletion (auth.users cascade). */
async function deleteUser(sql: Sql, n: number): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${U(n)}'`);
}

async function asUser(tx: Tx, n: number): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${U(n)}'`);
  await tx.unsafe(`set local request.jwt.claims = '{"session_id":"${SESSION(n)}"}'`);
}

function inTx<T>(sql: Sql, n: number | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    if (n !== null) await asUser(tx as unknown as Tx, n);
    return await fn(tx as unknown as Tx);
  }) as Promise<T>;
}

function barrier(): { gate: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open };
}

function pgError(e: unknown): { code: string; message: string } {
  const err = e as { code?: string; message?: string };
  return { code: err.code ?? "?", message: err.message ?? String(e) };
}

/** Run `fn` on N independent connections as user `n`, every lane starting
 * from a barrier after its transaction is open. Errors are captured per lane. */
async function burst<T>(
  sql: Sql,
  n: number,
  lanes: number,
  fn: (tx: Tx, lane: number) => Promise<T>,
): Promise<Array<{ ok: true; value: T } | { ok: false; code: string; message: string }>> {
  const b = barrier();
  const ready: Array<() => void> = [];
  const allReady = new Promise<void>((resolve) => {
    let count = 0;
    for (let i = 0; i < lanes; i += 1) {
      ready.push(() => {
        count += 1;
        if (count === lanes) resolve();
      });
    }
  });
  const runs = Array.from({ length: lanes }, (_, lane) =>
    inTx(sql, n, async (tx) => {
      ready[lane]();
      await b.gate;
      return await fn(tx, lane);
    })
      .then((value) => ({ ok: true as const, value }))
      .catch((e) => ({ ok: false as const, ...pgError(e) })),
  );
  await allReady;
  b.open();
  return await Promise.all(runs);
}

/** Lane A runs `first` and parks its transaction open; lane B then runs
 * `second` on another connection (B may block on A's uncommitted rows and
 * resumes when A commits). Returns both outcomes. */
async function overlap<A, B>(
  sql: Sql,
  a: { n: number; fn: (tx: Tx) => Promise<A> },
  b: { n: number; fn: (tx: Tx) => Promise<B> },
): Promise<{ a: A; b: B | { error: string } }> {
  const parked = barrier();
  const aDone = barrier();
  let aResult: A | undefined;
  const laneA = inTx(sql, a.n, async (tx) => {
    aResult = await a.fn(tx);
    aDone.open();
    await parked.gate;
  });
  await aDone.gate;
  const laneB = inTx(sql, b.n, b.fn).catch((e) => ({
    error: `${pgError(e).code}:${pgError(e).message}`,
  }));
  // Give B time to run up to (or block on) A's uncommitted work, then commit A.
  await new Promise((resolve) => setTimeout(resolve, 400));
  parked.open();
  await laneA;
  const bResult = await laneB;
  return { a: aResult as A, b: bResult };
}

async function register(
  tx: Tx,
  key: string,
): Promise<{ result: string; device_id: string | null }> {
  const rows = await tx.unsafe<{ result: string; device_id: string | null }[]>(
    `select r.result, r.device_id::text as device_id
     from public.register_offline_device('${key}', 'production', true) r`,
  );
  return rows[0];
}

type Grant = { result: string; grant_id: string | null; ticket_ids: string[] | null };
async function issue(tx: Tx, key: string, requested = 2): Promise<Grant> {
  const rows = await tx.unsafe<Grant[]>(
    `select g.result, g.grant_id::text as grant_id, g.ticket_ids::text[] as ticket_ids
     from public.issue_offline_grant('${key}', ${requested}) g`,
  );
  return rows[0];
}

async function consume(
  tx: Tx,
  ticket: string,
  payload: Record<string, JSONValue>,
): Promise<string> {
  const rows = await tx.unsafe(
    `select public.consume_offline_ticket('${ticket}', $1::jsonb) as r`,
    [tx.json(payload)],
  );
  return String(rows[0].r);
}

async function release(tx: Tx, ticket: string): Promise<string> {
  const rows = await tx.unsafe(
    `select public.release_offline_ticket('${ticket}', 'unused_ticket_returned') as r`,
  );
  return String(rows[0].r);
}

async function reserve(tx: Tx, key: string): Promise<string> {
  const rows = await tx.unsafe(`select x.result from public.reserve_analysis_permit('${key}') x`);
  return String(rows[0].result);
}

async function ledger(sql: Sql, ticket: string): Promise<string[]> {
  const rows = await sql.unsafe(
    `select event from public.offline_allocation_ledger where ticket_id = '${ticket}' order by id`,
  );
  return rows.map((r) => String(r.event));
}

async function count(sql: Sql, query: string): Promise<number> {
  const rows = await sql.unsafe(`select count(*)::int as n from (${query}) q`);
  return Number(rows[0].n);
}

async function allocatedFor(sql: Sql, key: string): Promise<string[]> {
  const rows = await sql.unsafe(
    `select ticket_id::text as t from public.offline_allocation_ledger
     where installation_key_id = '${key}' and event = 'allocated' order by id`,
  );
  return rows.map((r) => String(r.t));
}

async function setupSingleUser(sql: Sql, n: number, key: string): Promise<string[]> {
  await createUser(sql, n, [{ provider: "google", sub: SUB(String(n)) }]);
  await inTx(sql, n, async (tx) => {
    assertEquals((await register(tx, key)).result, "accepted");
  });
  const grant = await inTx(sql, n, (tx) => issue(tx, key, 2));
  assertEquals(grant.result, "accepted");
  assertEquals(grant.ticket_ids?.length, 2);
  return grant.ticket_ids as string[];
}

Deno.test({
  name: "ATK-01 concurrency: register_offline_device() double-submitted for one (user, installation key) in overlapping transactions — both must be accepted (the RPC is documented idempotent), never a raised unique_violation",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await createUser(sql, 1, [{ provider: "google", sub: SUB("1") }]);
      const key = KEY("atk01-installation");

      const outcome = await overlap(
        sql,
        { n: 1, fn: (tx) => register(tx, key) },
        { n: 1, fn: (tx) => register(tx, key) },
      );
      assertEquals(outcome.a.result, "accepted", "first submit");
      assertEquals(
        await count(
          sql,
          `select 1 from public.offline_devices where installation_key_id = '${key}'`,
        ),
        1,
        "exactly one device row",
      );
      assert(
        !("error" in outcome.b),
        `second submit must not raise (got ${"error" in outcome.b ? outcome.b.error : "ok"})`,
      );
      const second = outcome.b as { result: string; device_id: string | null };
      assertEquals(second.result, "accepted", "second submit replays as accepted");
      assertEquals(second.device_id, outcome.a.device_id, "same device id");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATK-02 concurrency: 16 issue_offline_grant() lanes on one fresh installation — exactly two tickets are ever allocated, every lane accepted with the same ticket set",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 20 });
    try {
      await createUser(sql, 2, [{ provider: "apple", sub: SUB("2") }]);
      const key = KEY("atk02-installation");
      await inTx(sql, 2, async (tx) => {
        assertEquals((await register(tx, key)).result, "accepted");
      });

      const results = await burst(sql, 2, 16, (tx) => issue(tx, key, 2));
      const failures = results.filter((r) => !r.ok);
      assertEquals(failures, [], "no lane may raise");
      const grants = results.map((r) => (r.ok ? r.value : null)) as Grant[];
      for (const g of grants) assertEquals(g.result, "accepted");
      const sets = new Set(grants.map((g) => [...(g.ticket_ids ?? [])].sort().join(",")));
      assertEquals(
        sets.size,
        1,
        `every lane sees the same ticket set (got ${[...sets].join(" | ")})`,
      );
      assertEquals((await allocatedFor(sql, key)).length, 2, "two allocated rows");
      // Every call mints a generation (documented); none may mint a ticket.
      const generations = await count(
        sql,
        `select 1 from public.offline_grants g join public.offline_devices d on d.id = g.device_id
         where d.installation_key_id = '${key}'`,
      );
      assert(generations >= 1 && generations <= 16, `generations ${generations}`);
      assertEquals(
        await count(
          sql,
          `select 1 from public.offline_allocation_ledger where installation_key_id = '${key}'`,
        ),
        2,
        "the ledger holds exactly the two allocations",
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATK-03 conservation under contention: one free identity, 6 attested devices allocating while 6 online reservations race — scored + live permits + outstanding tickets never exceeds 2 and access_state() agrees",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 20 });
    try {
      await createUser(sql, 3, [{ provider: "google", sub: SUB("3") }]);
      const keys = Array.from({ length: 6 }, (_, i) => KEY(`atk03-device-${i}`));
      for (const key of keys) {
        await inTx(sql, 3, async (tx) => {
          assertEquals((await register(tx, key)).result, "accepted");
        });
      }

      const results = await burst(sql, 3, 12, async (tx, lane) => {
        if (lane < 6) {
          const g = await issue(tx, keys[lane], 2);
          return `grant:${g.result}:${g.ticket_ids?.length ?? 0}`;
        }
        return `permit:${await reserve(tx, `atk03-permit-${lane}`)}`;
      });
      assertEquals(
        results.filter((r) => !r.ok),
        [],
        "no lane may raise",
      );

      const live = await count(
        sql,
        `select 1 from public.analysis_permits where user_id = '${U(3)}' and status = 'reserved'`,
      );
      const outstanding = await count(
        sql,
        `select 1 from public.offline_allocation_ledger a
         where a.user_id = '${U(3)}' and a.event = 'allocated'
           and not exists (select 1 from public.offline_allocation_ledger t
                           where t.ticket_id = a.ticket_id and t.event in ('consumed','released'))`,
      );
      assert(live + outstanding <= 2, `live ${live} + outstanding ${outstanding} must be <= 2`);
      assertEquals(live + outstanding, 2, "the two units were handed out, not lost");

      const state = await inTx(sql, 3, async (tx) => {
        const rows = await tx.unsafe<{ s: number; r: number }[]>(
          `select scored_count::int as s, reserved_count::int as r from public.access_state()`,
        );
        return rows[0];
      });
      assertEquals(state.s, 0);
      assertEquals(state.r, live + outstanding, "access_state().reserved_count matches the DB");

      // Nothing more is available on any path.
      for (const key of keys) {
        const g = await inTx(sql, 3, (tx) => issue(tx, key, 2));
        const held = (await allocatedFor(sql, key)).length;
        if (held === 0) {
          assertEquals(g.result, "access.paywall_required", `late allocation on ${key}`);
        } else assertEquals(g.result, "accepted", `re-issue of ${key}'s outstanding tickets`);
        assertEquals((await allocatedFor(sql, key)).length, held, `no new ticket for ${key}`);
      }
      assertEquals(
        await inTx(sql, 3, (tx) => reserve(tx, "atk03-late")),
        "access.paywall_required",
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATK-04 reentrancy: 16 consume lanes on one ticket with distinct shot ids, then 8 consume + 8 release lanes on the sibling — exactly one terminal event and one shot per ticket",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 20 });
    try {
      const key = KEY("atk04-installation");
      const [t1, t2] = await setupSingleUser(sql, 4, key);

      const first = await burst(sql, 4, 16, (tx) => consume(tx, t1, shotPayload(shotId())));
      assertEquals(
        first.filter((r) => !r.ok),
        [],
        "no lane may raise",
      );
      const verdicts = first.map((r) => (r.ok ? r.value : "raised"));
      assertEquals(
        verdicts.filter((v) => v === "accepted").length,
        1,
        `one accepted (${verdicts})`,
      );
      assertEquals(
        verdicts.filter((v) => v === "offline.ticket_consumed").length,
        15,
        `the other 15 see ticket_consumed (${verdicts})`,
      );
      assertEquals(await ledger(sql, t1), ["allocated", "consumed"]);
      assertEquals(
        await count(sql, `select 1 from public.shots where offline_ticket_id = '${t1}'`),
        1,
      );

      const second = await burst(sql, 4, 16, (tx, lane) =>
        lane % 2 === 0 ? consume(tx, t2, shotPayload(shotId())) : release(tx, t2),
      );
      assertEquals(
        second.filter((r) => !r.ok),
        [],
        "no lane may raise",
      );
      const events = await ledger(sql, t2);
      assertEquals(events.length, 2, `allocated + exactly one terminal event (got ${events})`);
      assert(events[1] === "consumed" || events[1] === "released");
      const shots = await count(
        sql,
        `select 1 from public.shots where offline_ticket_id = '${t2}'`,
      );
      assertEquals(shots, events[1] === "consumed" ? 1 : 0, "a released ticket backs no shot");

      // lifetime_scored_count() moved by exactly the consumed tickets.
      const scored = await count(
        sql,
        `select 1 from public.shots where user_id = '${U(4)}' and result_kind = 'scored'`,
      );
      assertEquals(scored, 1 + shots);
    } finally {
      await sql.end();
    }
  },
});

/** Account `base` (google I + apple J) allocates two tickets, deletes the
 * account, then signs in with I → account base+1 and J → account base+2. Both
 * new accounts own the original installation's tickets through their identity
 * hashes. (Three fresh account ids per call: production never reuses one.) */
async function splitIdentities(sql: Sql, base: number, key: string): Promise<string[]> {
  const I: Identity = { provider: "google", sub: SUB(`split-I-${key}`) };
  const J: Identity = { provider: "apple", sub: SUB(`split-J-${key}`) };
  await createUser(sql, base, [I, J]);
  await inTx(sql, base, async (tx) => {
    assertEquals((await register(tx, key)).result, "accepted");
  });
  const grant = await inTx(sql, base, (tx) => issue(tx, key, 2));
  assertEquals(grant.result, "accepted");
  assertEquals(grant.ticket_ids?.length, 2);
  await deleteUser(sql, base);
  await createUser(sql, base + 1, [I]);
  await createUser(sql, base + 2, [J]);
  // Original-installation recovery: each re-created account registers the
  // same installation key and is re-issued the outstanding tickets.
  for (const n of [base + 1, base + 2]) {
    await inTx(sql, n, async (tx) => {
      assertEquals((await register(tx, key)).result, "accepted");
    });
    const reissued = await inTx(sql, n, (tx) => issue(tx, key, 2));
    assertEquals(reissued.result, "accepted", `recovery on account ${n}`);
    assertEquals(
      [...(reissued.ticket_ids ?? [])].sort(),
      [...(grant.ticket_ids as string[])].sort(),
      `account ${n} recovers the original tickets, no new ones`,
    );
  }
  return grant.ticket_ids as string[];
}

Deno.test({
  name: "ATK-05 duplicate identities: after account deletion the two sign-in identities re-create two accounts that both own the installation's ticket — release on one overlapping consume on the other must leave exactly ONE terminal event",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 6 });
    try {
      const [t1] = await splitIdentities(sql, 10, KEY("atk05"));

      const outcome = await overlap(
        sql,
        { n: 12, fn: (tx) => consume(tx, t1, shotPayload(shotId())) },
        { n: 11, fn: (tx) => release(tx, t1) },
      );
      const events = await ledger(sql, t1);
      const terminal = events.filter((e) => e !== "allocated");
      assertEquals(
        terminal.length,
        1,
        `consume=${outcome.a} release=${JSON.stringify(
          outcome.b,
        )} → ledger ${events}: a ticket has one terminal state`,
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATK-06 duplicate identities: the same split, consume on both accounts with different shots overlapping — one shot, one consumed event, the loser is refused with the ticket verdict",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 6 });
    try {
      const [t1, t2] = await splitIdentities(sql, 13, KEY("atk06"));
      const outcome = await overlap(
        sql,
        { n: 14, fn: (tx) => consume(tx, t1, shotPayload(shotId())) },
        { n: 15, fn: (tx) => consume(tx, t1, shotPayload(shotId())) },
      );
      assertEquals(outcome.a, "accepted");
      assert(typeof outcome.b === "string", `loser must not raise (${JSON.stringify(outcome.b)})`);
      assert(outcome.b !== "accepted", "the loser is refused");
      // The loser's shot id exists nowhere; by the RPC's own contract
      // shot.id_conflict means "another user's shot has this id" and
      // offline.ticket_consumed means "this ticket settled another shot".
      assertEquals(
        outcome.b,
        "offline.ticket_consumed",
        "the loser is told the TICKET is consumed, not that its own shot id conflicts",
      );
      assertEquals(await ledger(sql, t1), ["allocated", "consumed"]);
      assertEquals(
        await count(sql, `select 1 from public.shots where offline_ticket_id = '${t1}'`),
        1,
      );

      // Sequential (no overlap): the second account sees the settled ticket.
      assertEquals(
        await inTx(sql, 15, (tx) => consume(tx, t1, shotPayload(shotId()))),
        "offline.ticket_consumed",
      );
      assertEquals(await inTx(sql, 15, (tx) => release(tx, t1)), "offline.ticket_consumed");
      // The sibling ticket is still one unit for the pair, not one each.
      assertEquals(await inTx(sql, 14, (tx) => consume(tx, t2, shotPayload(shotId()))), "accepted");
      assertEquals(
        await inTx(sql, 15, (tx) => consume(tx, t2, shotPayload(shotId()))),
        "offline.ticket_consumed",
      );
      assertEquals(await ledger(sql, t2), ["allocated", "consumed"]);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATK-07 process death / restart: a settlement whose reply was lost replays as accepted with no second shot; a malformed detail row rolls the WHOLE settlement back and the ticket stays outstanding for a clean retry",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const key = KEY("atk07-installation");
      const [t1, t2] = await setupSingleUser(sql, 7, key);

      // 1. Committed, reply lost, device restarts and replays the same (ticket, shot).
      const s1 = shotId();
      assertEquals(await inTx(sql, 7, (tx) => consume(tx, t1, shotPayload(s1))), "accepted");
      assertEquals(await inTx(sql, 7, (tx) => consume(tx, t1, shotPayload(s1))), "accepted");
      assertEquals(await inTx(sql, 7, (tx) => consume(tx, t1, shotPayload(s1))), "accepted");
      assertEquals(await ledger(sql, t1), ["allocated", "consumed"]);
      assertEquals(await count(sql, `select 1 from public.shots where id = '${s1}'`), 1);
      // A replay under a DIFFERENT shot id after the crash is refused.
      assertEquals(
        await inTx(sql, 7, (tx) => consume(tx, t1, shotPayload(shotId()))),
        "offline.ticket_consumed",
      );

      // 2. The RPC's own transaction died before commit (connection dropped).
      const s2 = shotId();
      const dropped = await sql
        .begin(async (tx) => {
          await asUser(tx as unknown as Tx, 7);
          const r = await consume(tx as unknown as Tx, t2, shotPayload(s2));
          assertEquals(r, "accepted");
          throw new Error("simulated connection loss before commit");
        })
        .catch((e) => String((e as Error).message));
      assertEquals(dropped, "simulated connection loss before commit");
      assertEquals(await ledger(sql, t2), ["allocated"], "nothing of the dead settlement persists");
      assertEquals(await count(sql, `select 1 from public.shots where id = '${s2}'`), 0);

      // 3. A malformed phase inside the settlement: shot, details and ledger
      //    row all roll back; the ticket stays outstanding; the retry succeeds.
      const bad = shotPayload(s2, {
        phases: [
          {
            key: "backswing",
            startMs: "not-a-number",
            representativeMs: 1,
            endMs: 2,
            confidence: 0.5,
          },
        ],
      });
      const verdict = await inTx(sql, 7, (tx) => consume(tx, t2, bad));
      assert(
        verdict.startsWith("shot.write_failed:"),
        `malformed detail → write_failed (got ${verdict})`,
      );
      assert(!verdict.includes("not-a-number"), "the verdict never echoes client input");
      assertEquals(await ledger(sql, t2), ["allocated"], "ticket still outstanding");
      assertEquals(
        await count(sql, `select 1 from public.shots where id = '${s2}'`),
        0,
        "no half-written shot",
      );
      assertEquals(await count(sql, `select 1 from public.shot_phases where shot_id = '${s2}'`), 0);

      assertEquals(await inTx(sql, 7, (tx) => consume(tx, t2, shotPayload(s2))), "accepted");
      assertEquals(await ledger(sql, t2), ["allocated", "consumed"]);
      // Both tickets spent: the identity is at its lifetime allowance.
      assertEquals(
        await inTx(sql, 7, (tx) => reserve(tx, "atk07-online")),
        "access.paywall_required",
      );
      assertEquals(
        await inTx(sql, 7, (tx) => issue(tx, key, 2)).then((g) => g.result),
        "access.paywall_required",
      );
    } finally {
      await sql.end();
    }
  },
});
