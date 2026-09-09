/**
 * W04-01 — offline device registry / grants / allocation ledger under REAL
 * concurrency (regression for the round-6 adversary breaks ATK-01, ATK-05,
 * ATK-06 and the ATK-04 burst shape).
 *
 * Same harness shape as xc_pg_rpc_concurrency.test.ts: a disposable
 * postgres:16 with shim_auth.sql + every migration applied (./xc_pg_up.sh),
 * every client statement as role `authenticated` with a JWT sub AND a live
 * auth.sessions row named in request.jwt.claims (the W04-01 RPCs require
 * api_private.is_active_session()), nothing mocked. Owner-role statements
 * stand in for Supabase Auth (account creation / deletion) and are labelled.
 *
 *   ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json w04_01_offline_grants_concurrency.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
 * ignored run is NOT a pass (the W04-01-AC3 gate runs with XC_PG_URL set).
 *
 * Interleavings are DETERMINISTIC where the case needs one: lane A runs its
 * RPC inside an open transaction and parks before COMMIT; lane B then runs
 * its RPC on an independent connection (it cannot see A's uncommitted rows
 * and, where it blocks on A's lock or index, resumes only when A commits).
 * Bursts release N connections from a barrier so they genuinely contend.
 *
 * What must hold (the migration's contract):
 *   R1  register_offline_device() is idempotent under a double submit: two
 *       overlapping first registrations of one (user, installation key) both
 *       answer accepted with the SAME device id and one row exists — never a
 *       raised 23505 (the FOR UPDATE on a row that does not exist yet locks
 *       nothing; the RPC must hold the caller lock across check-then-insert).
 *   R2  a ticket has exactly ONE terminal event even when two RECOVERED
 *       accounts (the two sign-in identities of a deleted account, each
 *       re-created on its own) settle it concurrently — consume on one
 *       overlapping release on the other: the loser sees the winner's
 *       committed row and answers the ticket verdict, never a second row.
 *   R3  the same split, consume vs consume with different shots: one shot,
 *       one consumed event, and the loser is told offline.ticket_consumed —
 *       not shot.id_conflict (its own shot id exists nowhere).
 *   R4  one account, 8 consume + 8 release lanes on one ticket from a
 *       barrier: no lane raises, exactly one terminal event, a released
 *       ticket backs no shot, lifetime_scored_count() moves by exactly the
 *       consumed tickets.
 *   R5  the table itself refuses a second terminal word for a ticket (unique
 *       partial index over the two terminal events), with the row guard out
 *       of the way — the RPC lock is the first line, the index the last.
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
const U = (n: number): string => `0000000b-0401-4000-8000-${RUN}00${String(n).padStart(2, "0")}`;
const SESSION = (n: number): string =>
  `0000000b-0401-4000-8000-${RUN}0a${String(n).padStart(2, "0")}`;
const KEY = (name: string): string => `${name}-${RUN}`;
const SUB = (name: string): string => `w04-01-${name}-${RUN}`;

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

function shotPayload(id: string): Record<string, JSONValue> {
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
  };
}

let shotSeq = 0;
function shotId(): string {
  shotSeq += 1;
  return `0000000b-0401-4000-8000-${RUN}5${String(shotSeq).padStart(3, "0")}`;
}

type Identity = { provider: "google" | "apple"; sub: string };

/** Owner role stands in for Supabase Auth: (re)create a user with its
 * sign-in identities and one live session. */
async function createUser(sql: Sql, n: number, identities: Identity[]): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${U(n)}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${U(n)}', 'w04-01-${n}-${RUN}@example.com', '{"provider":"${identities[0].provider}"}')`,
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
 * `second` on another connection (B may block on A's uncommitted work and
 * resumes when A commits). Returns both outcomes. */
async function overlap<A, B>(
  sql: Sql,
  a: { n: number; fn: (tx: Tx) => Promise<A> },
  b: { n: number; fn: (tx: Tx) => Promise<B> },
): Promise<{ a: A; b: B | { error: string } }> {
  const parked = barrier();
  const aDone = barrier();
  let aResult: A | undefined;
  let aError: unknown;
  const laneA = inTx(sql, a.n, async (tx) => {
    aResult = await a.fn(tx);
    aDone.open();
    await parked.gate;
  }).catch((e) => {
    aError = e;
    aDone.open();
  });
  await aDone.gate;
  if (aError !== undefined) {
    parked.open();
    await laneA;
    throw aError;
  }
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
  name: "W04-01 R1: register_offline_device() double-submitted for one (user, installation key) in overlapping transactions — both accepted with the same device id, one row, never a raised unique_violation",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await createUser(sql, 1, [{ provider: "google", sub: SUB("1") }]);
      const key = KEY("r1-installation");

      const outcome = await overlap(
        sql,
        { n: 1, fn: (tx) => register(tx, key) },
        { n: 1, fn: (tx) => register(tx, key) },
      );
      assertEquals(outcome.a.result, "accepted", "first submit");
      assert(
        !("error" in outcome.b),
        `second submit must not raise (got ${"error" in outcome.b ? outcome.b.error : "ok"})`,
      );
      const second = outcome.b as { result: string; device_id: string | null };
      assertEquals(second.result, "accepted", "second submit replays as accepted");
      assertEquals(second.device_id, outcome.a.device_id, "same device id");
      assertEquals(
        await count(
          sql,
          `select 1 from public.offline_devices where installation_key_id = '${key}'`,
        ),
        1,
        "exactly one device row",
      );
      // A registered device is still attested and still grants (the replay
      // did not downgrade or duplicate anything).
      const grant = await inTx(sql, 1, (tx) => issue(tx, key, 2));
      assertEquals(grant.result, "accepted");
      assertEquals(grant.ticket_ids?.length, 2);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "W04-01 R2: after account deletion the two sign-in identities re-create two accounts that both own the installation's ticket — consume on one overlapping release on the other leaves exactly ONE terminal event and the loser gets the ticket verdict",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 6 });
    try {
      const [t1, t2] = await splitIdentities(sql, 10, KEY("r2"));

      // A (account 12) consumes and parks; B (account 11) releases.
      const first = await overlap(
        sql,
        { n: 12, fn: (tx) => consume(tx, t1, shotPayload(shotId())) },
        { n: 11, fn: (tx) => release(tx, t1) },
      );
      assertEquals(first.a, "accepted", "the consume that reached the ticket first settles it");
      assertEquals(
        first.b,
        "offline.ticket_consumed",
        "the overlapping release waits for the ticket and reports it consumed",
      );
      assertEquals(await ledger(sql, t1), ["allocated", "consumed"]);
      assertEquals(
        await count(sql, `select 1 from public.shots where offline_ticket_id = '${t1}'`),
        1,
        "one shot settles the ticket",
      );

      // The mirror image on the sibling ticket: release parks, consume overlaps.
      const second = await overlap(
        sql,
        { n: 11, fn: (tx) => release(tx, t2) },
        { n: 12, fn: (tx) => consume(tx, t2, shotPayload(shotId())) },
      );
      assertEquals(second.a, "accepted", "the release that reached the ticket first closes it");
      assertEquals(
        second.b,
        "offline.ticket_released",
        "the overlapping consume waits for the ticket and reports it released",
      );
      assertEquals(await ledger(sql, t2), ["allocated", "released"]);
      assertEquals(
        await count(sql, `select 1 from public.shots where offline_ticket_id = '${t2}'`),
        0,
        "a released ticket backs no shot",
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "W04-01 R3: the same split, consume on both accounts with different shots overlapping — one shot, one consumed event, the loser is told offline.ticket_consumed (never shot.id_conflict)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 6 });
    try {
      const [t1, t2] = await splitIdentities(sql, 13, KEY("r3"));
      const outcome = await overlap(
        sql,
        { n: 14, fn: (tx) => consume(tx, t1, shotPayload(shotId())) },
        { n: 15, fn: (tx) => consume(tx, t1, shotPayload(shotId())) },
      );
      assertEquals(outcome.a, "accepted");
      assert(typeof outcome.b === "string", `loser must not raise (${JSON.stringify(outcome.b)})`);
      // By the RPC's own contract shot.id_conflict means "another user's shot
      // has this id" and offline.ticket_consumed means "this ticket settled
      // another shot"; the loser's shot id exists nowhere.
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
      assertEquals(
        await count(
          sql,
          `select 1 from public.offline_allocation_ledger
           where ticket_id in ('${t1}', '${t2}') and event = 'consumed'`,
        ),
        2,
        "two tickets, two consumptions, for the whole identity pair",
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "W04-01 R4: one account, 8 consume + 8 release lanes on one ticket from a barrier — no lane raises, exactly one terminal event, a released ticket backs no shot, the lifetime count moves by exactly the consumed tickets",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 20 });
    try {
      const [t1, t2] = await setupSingleUser(sql, 4, KEY("r4"));

      const first = await burst(sql, 4, 16, (tx) => consume(tx, t1, shotPayload(shotId())));
      assertEquals(
        first.filter((r) => !r.ok),
        [],
        "no consume lane may raise",
      );
      const accepted = first.filter((r) => r.ok && r.value === "accepted").length;
      assertEquals(accepted, 1, `exactly one consume wins (${JSON.stringify(first)})`);
      assertEquals(
        first.filter((r) => r.ok && r.value === "offline.ticket_consumed").length,
        15,
        `every loser is told the ticket is consumed (${JSON.stringify(first)})`,
      );
      assertEquals(await ledger(sql, t1), ["allocated", "consumed"]);

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
      for (const lane of second) {
        assert(lane.ok);
        assert(
          lane.value === "accepted" ||
            lane.value ===
              (events[1] === "consumed" ? "offline.ticket_consumed" : "offline.ticket_released"),
          `every lane answers accepted or the ticket verdict (got ${lane.value})`,
        );
      }
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

Deno.test({
  name: "W04-01 R5: the ledger itself holds one terminal event per ticket — with the row guard out of the way, a second terminal word for a consumed ticket is refused by the unique partial index (owner role, rolled back)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      const [t1] = await setupSingleUser(sql, 5, KEY("r5"));
      assertEquals(await inTx(sql, 5, (tx) => consume(tx, t1, shotPayload(shotId()))), "accepted");
      const index = await sql.unsafe<{ indexdef: string }[]>(
        `select indexdef from pg_indexes
         where schemaname = 'public' and tablename = 'offline_allocation_ledger'
           and indexname = 'offline_allocation_ledger_one_terminal_idx'`,
      );
      assertEquals(index.length, 1, "the one-terminal index exists");
      const def = index[0].indexdef.toLowerCase();
      assert(
        def.includes("unique") &&
          def.includes("where") &&
          def.includes("'consumed'") &&
          def.includes("'released'"),
        `unique partial index over the terminal words (got ${index[0].indexdef})`,
      );

      const outcome = await sql
        .begin(async (tx) => {
          await tx.unsafe(
            `alter table public.offline_allocation_ledger disable trigger offline_allocation_ledger_guard_event`,
          );
          await tx.unsafe(
            `insert into public.offline_allocation_ledger
               (user_id, device_id, grant_id, generation, ticket_id, event, reason, identity_hashes, installation_key_id)
             select a.user_id, a.device_id, a.grant_id, a.generation, a.ticket_id, 'released', 'support_review',
                    a.identity_hashes, a.installation_key_id
             from public.offline_allocation_ledger a
             where a.ticket_id = '${t1}' and a.event = 'allocated'`,
          );
          return "inserted";
        })
        .then((v) => ({ ok: true as const, value: v }))
        .catch((e) => ({ ok: false as const, ...pgError(e) }));
      assert(!outcome.ok, "a released row beside a consumed row must be refused at the table");
      assertEquals(
        outcome.code,
        "23505",
        `unique_violation from the one-terminal index (${outcome.message})`,
      );
      assertEquals(await ledger(sql, t1), ["allocated", "consumed"]);
      // The guard is back (the ALTER rolled back with the transaction).
      const guard = await sql.unsafe<{ tgenabled: string }[]>(
        `select tgenabled from pg_trigger
         where tgrelid = 'public.offline_allocation_ledger'::regclass
           and tgname = 'offline_allocation_ledger_guard_event'`,
      );
      assertEquals(guard[0]?.tgenabled, "O", "the row guard is enabled again");
    } finally {
      await sql.end();
    }
  },
});
