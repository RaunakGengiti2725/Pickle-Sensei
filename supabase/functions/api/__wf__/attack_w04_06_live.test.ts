/**
 * W04-06 ADVERSARY — live-PostgreSQL attacks on the candidate migration
 * 20260910140000_offline_grants_unattested_installations (fbc1cc99) under REAL
 * concurrency and process death, in the harness shape of
 * w04_01_offline_grants_concurrency.test.ts: a disposable postgres:16 with
 * shim_auth.sql + every migration applied (./xc_pg_up.sh), every client
 * statement as role `authenticated` with a JWT sub AND a live auth.sessions
 * row, nothing mocked. Owner-role statements stand in for Supabase Auth and
 * for the support/App-Attest paths that write offline_devices directly (the
 * client holds no UPDATE on that table) and are labelled.
 *
 *   ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json attack_w04_06_live.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
 * ignored run is NOT a pass.
 *
 * Every test asserts the behaviour the candidate claims; a failing test is a
 * confirmed break.
 *
 *   ATK-L1  revoke ‖ issue: an uncommitted revocation (support path) overlaps
 *           a grant request — the grant must not be issued AFTER the
 *           revocation instant (issued_at > revoked_at with both rows
 *           committed is a grant for a revoked device)
 *   ATK-L2  revoke while the grant request is queued on the per-identity
 *           advisory lock: the request must answer offline.device_revoked
 *           (the shipping app's 403) — never a raised exception (a 503)
 *   ATK-L3  burst: one free identity, two installations, 8 overlapping grant
 *           requests — no lane raises, at most two distinct tickets exist,
 *           the hold count is 2, generations are unique per installation
 *   ATK-L4  process death between steps: a grant request whose transaction
 *           dies before COMMIT leaves no grant, no ledger row and no hold;
 *           register → die → register → issue is idempotent
 *   ATK-L5  attestation flip while the grant request is queued on the lock:
 *           the grant must record ONE of the two truthful states, never fail
 *           (owner/App-Attest path flips the device row)
 *   ATK-L6  double submit of one installation's grant request in overlapping
 *           transactions: both accepted, same two tickets, consecutive
 *           generations, one allocation
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const RUN = crypto.randomUUID().slice(0, 8);
const U = (n: number): string => `0000000b-0406-4000-8000-${RUN}00${String(n).padStart(2, "0")}`;
const SESSION = (n: number): string =>
  `0000000b-0406-4000-8000-${RUN}0a${String(n).padStart(2, "0")}`;
const KEY = (name: string): string => `atk0406-${name}-${RUN}`;

async function createUser(sql: Sql, n: number): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${U(n)}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${U(n)}', 'atk0406-${n}-${RUN}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', 'atk0406-${n}-${RUN}', '${U(n)}', '{"sub":"atk0406-${n}-${RUN}"}')`,
  );
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${SESSION(n)}', '${U(n)}')`);
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Outcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
const outcome = <T>(p: Promise<T>): Promise<Outcome<T>> =>
  p
    .then((value) => ({ ok: true as const, value }))
    .catch((e) => ({
      ok: false as const,
      ...pgError(e),
    }));

/** Lane A runs `first` and parks its transaction open; lane B then runs
 * `second` on another connection; `meanwhile` (optional, autocommit) runs
 * once B has had time to reach A's lock; then A commits and B completes. */
async function overlap<A, B>(
  sql: Sql,
  a: { n: number | null; fn: (tx: Tx) => Promise<A> },
  b: { n: number | null; fn: (tx: Tx) => Promise<B> },
  meanwhile?: () => Promise<void>,
): Promise<{ a: A; b: Outcome<B> }> {
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
  const laneB = outcome(inTx(sql, b.n, b.fn));
  await sleep(400);
  if (meanwhile) await meanwhile();
  await sleep(200);
  parked.open();
  await laneA;
  return { a: aResult as A, b: await laneB };
}

async function burst<T>(
  sql: Sql,
  n: number,
  lanes: number,
  fn: (tx: Tx, lane: number) => Promise<T>,
): Promise<Outcome<T>[]> {
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
    outcome(
      inTx(sql, n, async (tx) => {
        ready[lane]();
        await b.gate;
        return await fn(tx, lane);
      }),
    ),
  );
  await allReady;
  b.open();
  return await Promise.all(runs);
}

type Registered = { result: string; device_id: string | null };
async function register(tx: Tx, key: string, attested = false): Promise<Registered> {
  const rows = await tx.unsafe<Registered[]>(
    `select r.result, r.device_id::text as device_id
     from public.register_offline_device('${key}', 'production', ${attested}) r`,
  );
  return rows[0];
}

type Grant = {
  result: string;
  grant_id: string | null;
  generation: number | null;
  ticket_ids: string[] | null;
  attestation_state: string | null;
  issued_at: string | null;
};
async function issue(tx: Tx, key: string, requested = 2): Promise<Grant> {
  const rows = await tx.unsafe<Grant[]>(
    `select g.result, g.grant_id::text as grant_id, g.generation, g.ticket_ids::text[] as ticket_ids,
            g.attestation_state, g.issued_at::text as issued_at
     from public.issue_offline_grant('${key}', ${requested}) g`,
  );
  return rows[0];
}

async function count(sql: Sql, query: string): Promise<number> {
  const rows = await sql.unsafe(`select count(*)::int as n from (${query}) q`);
  return Number(rows[0].n);
}

async function holdCount(sql: Sql, n: number): Promise<number> {
  return await inTx(sql, n, async (tx) => {
    const rows = await tx.unsafe(`select public.offline_hold_count() as n`);
    return Number(rows[0].n);
  });
}

async function registerUser(sql: Sql, n: number, key: string): Promise<string> {
  await createUser(sql, n);
  const r = await inTx(sql, n, (tx) => register(tx, key));
  assertEquals(r.result, "accepted", "precondition: the shipping app registers unattested");
  return r.device_id as string;
}

Deno.test({
  name: "ATK-L1 (concurrency): a revocation committed while an overlapping grant request is in flight never leaves a grant issued after the revocation instant",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const key = KEY("l1");
      const device = await registerUser(sql, 1, key);

      // Lane A (owner: support path) revokes and parks before COMMIT; lane B
      // (the phone) asks for a grant; A commits.
      const result = await overlap(
        sql,
        {
          n: null,
          fn: async (tx) => {
            await tx.unsafe(
              `update public.offline_devices set revoked_at = now() where id = '${device}'`,
            );
            return "revoked";
          },
        },
        { n: 1, fn: (tx) => issue(tx, key, 2) },
      );
      assert(result.b.ok, `the grant request must not raise (${JSON.stringify(result.b)})`);

      const rows = await sql.unsafe(
        `select g.id::text as id, g.issued_at, d.revoked_at
         from public.offline_grants g join public.offline_devices d on d.id = g.device_id
         where d.id = '${device}'`,
      );
      const late = rows.filter(
        (r) => r.revoked_at !== null && new Date(r.issued_at) > new Date(r.revoked_at),
      );
      assertEquals(
        late.length,
        0,
        `grant(s) issued AFTER the device's revocation instant: ${JSON.stringify(late)} (request answered ${result.b.value.result})`,
      );
      // And a revoked device holds no grant at all once both are committed.
      assertEquals(
        result.b.value.result,
        "offline.device_revoked",
        "the phone is told the installation is revoked",
      );
      assertEquals(
        await count(sql, `select 1 from public.offline_grants where device_id = '${device}'`),
        0,
        "no grant row for the revoked device",
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATK-L2 (concurrency): a revocation committed while the grant request waits on the per-identity lock answers offline.device_revoked — never a raised exception",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const key = KEY("l2");
      const device = await registerUser(sql, 2, key);

      // Lane A (owner) holds the identity's advisory lock and parks; lane B
      // (the phone) reads its device row then queues on that lock; the support
      // path revokes and commits; A releases; B continues.
      const result = await overlap(
        sql,
        {
          n: null,
          fn: async (tx) => {
            await tx.unsafe(
              `select pg_advisory_xact_lock(public.access_lock_key('${U(2)}'::uuid))`,
            );
            return "locked";
          },
        },
        { n: 2, fn: (tx) => issue(tx, key, 2) },
        async () => {
          await sql.unsafe(
            `update public.offline_devices set revoked_at = now() where id = '${device}'`,
          );
        },
      );
      assertEquals(
        await count(sql, `select 1 from public.offline_grants where device_id = '${device}'`),
        0,
        "no grant row for the revoked device",
      );
      assert(
        result.b.ok,
        `the grant request must answer a result row, not raise (got ${JSON.stringify(result.b)})`,
      );
      assertEquals(result.b.value.result, "offline.device_revoked");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATK-L3 (conservation): 8 overlapping grant requests from one free identity across two installations — no lane raises, two tickets exist, hold count 2, unique generations",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 10 });
    try {
      const keyA = KEY("l3-a");
      const keyB = KEY("l3-b");
      await registerUser(sql, 3, keyA);
      await inTx(sql, 3, async (tx) => {
        assertEquals((await register(tx, keyB)).result, "accepted");
      });

      const lanes = await burst(sql, 3, 8, (tx, lane) =>
        issue(tx, lane % 2 === 0 ? keyA : keyB, 2),
      );
      const raised = lanes.filter((l) => !l.ok);
      assertEquals(raised.length, 0, `lanes raised: ${JSON.stringify(raised)}`);
      const grants = lanes.flatMap((l) => (l.ok ? [l.value] : []));
      for (const g of grants) {
        assert(
          g.result === "accepted" || g.result === "access.paywall_required",
          `unexpected verdict ${g.result}`,
        );
      }
      const accepted = grants.filter((g) => g.result === "accepted");
      assert(accepted.length >= 1, "at least one lane is issued");
      const tickets = new Set(accepted.flatMap((g) => g.ticket_ids ?? []));
      assert(tickets.size <= 2, `more than two tickets issued: ${[...tickets]}`);
      assertEquals(
        await count(
          sql,
          `select distinct ticket_id from public.offline_allocation_ledger
           where user_id = '${U(3)}' and event = 'allocated'`,
        ),
        2,
        "exactly two tickets allocated for the identity",
      );
      assertEquals(await holdCount(sql, 3), 2);
      // Generations are unique per installation and dense from 1.
      const gens = await sql.unsafe(
        `select d.installation_key_id as key, array_agg(g.generation order by g.generation) as gens
         from public.offline_grants g join public.offline_devices d on d.id = g.device_id
         where g.user_id = '${U(3)}' group by d.installation_key_id`,
      );
      for (const row of gens) {
        const list = (row.gens as number[]).map(Number);
        assertEquals(
          list,
          list.map((_, i) => i + 1),
          `generations on ${row.key}: ${list}`,
        );
      }
      // Every accepted lane on the SAME installation saw the same ticket set.
      for (const key of [keyA, keyB]) {
        const sets = new Set(
          accepted
            .filter((g) => g.ticket_ids !== null && g.ticket_ids.length > 0)
            .map((g) => [...(g.ticket_ids as string[])].sort().join(","))
            .filter((s, _, all) => all.length > 0),
        );
        assert(sets.size <= 2, `${key}: inconsistent ticket sets across lanes ${[...sets]}`);
      }
      // The two installations never both hold tickets: the union is the pair.
      assertEquals(tickets.size, 2);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATK-L4 (process death): a grant request that dies before COMMIT leaves no grant, ledger row or hold; register → die → register → issue is idempotent",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const key = KEY("l4");
      await createUser(sql, 4);

      // Registration transaction dies before COMMIT.
      const died = await outcome(
        inTx(sql, 4, async (tx) => {
          assertEquals((await register(tx, key)).result, "accepted");
          throw new Error("process died before COMMIT");
        }),
      );
      assert(!died.ok);
      assertEquals(
        await count(
          sql,
          `select 1 from public.offline_devices where installation_key_id = '${key}'`,
        ),
        0,
        "no device row survives the dead registration",
      );
      const r1 = await inTx(sql, 4, (tx) => register(tx, key));
      const r2 = await inTx(sql, 4, (tx) => register(tx, key));
      assertEquals(r1.result, "accepted");
      assertEquals(r2.result, "accepted");
      assertEquals(r2.device_id, r1.device_id, "re-registration is idempotent");

      // Grant transaction dies before COMMIT.
      const dead = await outcome(
        inTx(sql, 4, async (tx) => {
          const g = await issue(tx, key, 2);
          assertEquals(g.result, "accepted");
          assertEquals(g.ticket_ids?.length, 2);
          throw new Error("process died before COMMIT");
        }),
      );
      assert(!dead.ok);
      assertEquals(
        await count(sql, `select 1 from public.offline_grants where user_id = '${U(4)}'`),
        0,
        "no grant survives",
      );
      assertEquals(
        await count(
          sql,
          `select 1 from public.offline_allocation_ledger where user_id = '${U(4)}'`,
        ),
        0,
        "no ledger row survives",
      );
      assertEquals(await holdCount(sql, 4), 0, "no hold survives");

      // The retry is generation 1 and records the installation's state.
      const g = await inTx(sql, 4, (tx) => issue(tx, key, 2));
      assertEquals(g.result, "accepted");
      assertEquals(g.generation, 1);
      assertEquals(g.attestation_state, "unattested");
      assertEquals(g.ticket_ids?.length, 2);
      assertEquals(await holdCount(sql, 4), 2);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATK-L5 (concurrency): the device is attested (owner/App-Attest path) while the grant request waits on the per-identity lock — the grant records one truthful state, never fails",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const key = KEY("l5");
      const device = await registerUser(sql, 5, key);

      const result = await overlap(
        sql,
        {
          n: null,
          fn: async (tx) => {
            await tx.unsafe(
              `select pg_advisory_xact_lock(public.access_lock_key('${U(5)}'::uuid))`,
            );
            return "locked";
          },
        },
        { n: 5, fn: (tx) => issue(tx, key, 2) },
        async () => {
          await sql.unsafe(
            `update public.offline_devices set attestation_state = 'attested', attested_at = now()
             where id = '${device}'`,
          );
        },
      );
      assert(
        result.b.ok,
        `the grant request must not raise while the device is upgraded (got ${JSON.stringify(result.b)})`,
      );
      assertEquals(result.b.value.result, "accepted");
      assert(
        result.b.value.attestation_state === "unattested" ||
          result.b.value.attestation_state === "attested",
        `state ${result.b.value.attestation_state}`,
      );
      // Whatever it recorded, the row agrees with what the RPC returned and
      // never claims more than the device row held at some point.
      const rows = await sql.unsafe(
        `select attestation_state from public.offline_grants where device_id = '${device}'`,
      );
      assertEquals(rows.length, 1);
      assertEquals(rows[0].attestation_state, result.b.value.attestation_state);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATK-L6 (replay): one installation's grant request double-submitted in overlapping transactions — both accepted, the same two tickets, consecutive generations, one allocation",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const key = KEY("l6");
      await registerUser(sql, 6, key);
      const result = await overlap(
        sql,
        { n: 6, fn: (tx) => issue(tx, key, 2) },
        { n: 6, fn: (tx) => issue(tx, key, 2) },
      );
      assertEquals(result.a.result, "accepted");
      assert(result.b.ok, JSON.stringify(result.b));
      assertEquals(result.b.value.result, "accepted");
      assertEquals(
        [...(result.b.value.ticket_ids ?? [])].sort(),
        [...(result.a.ticket_ids ?? [])].sort(),
        "the second submit is re-issued the first's tickets",
      );
      assertEquals([result.a.generation, result.b.value.generation].map(Number).sort(), [1, 2]);
      assertEquals(result.a.attestation_state, "unattested");
      assertEquals(result.b.value.attestation_state, "unattested");
      assertEquals(
        await count(
          sql,
          `select distinct ticket_id from public.offline_allocation_ledger
           where user_id = '${U(6)}' and event = 'allocated'`,
        ),
        2,
      );
      assertEquals(await holdCount(sql, 6), 2);
    } finally {
      await sql.end();
    }
  },
});
