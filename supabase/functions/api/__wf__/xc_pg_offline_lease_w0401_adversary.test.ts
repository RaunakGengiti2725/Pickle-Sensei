/**
 * INT-offline-lease adversary (round 2) — REAL Postgres attacks on the W04-01
 * offline device registry / grants / allocation ledger as integrated at
 * 2994371e1c5edf9a1e9bb12f6c6e4751e3fb4ea1
 * (supabase/migrations/20260908160000_offline_device_grants.sql).
 *
 * Same harness as w04_01_offline_grants_concurrency.test.ts: a disposable
 * postgres:16 with shim_auth.sql + every migration applied (./xc_pg_up.sh),
 * every client statement as role `authenticated` with a JWT sub AND a live
 * auth.sessions row (the RPCs require api_private.is_active_session()).
 * Owner-role statements stand in for Supabase Auth / historical rows and are
 * labelled. Nothing is mocked; production is never touched.
 *
 *   ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json xc_pg_offline_lease_w0401_adversary.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
 * ignored run is NOT a pass.
 *
 * A FAILING test is a reproduced break against the coordinator's product
 * invariants; a passing test is evidence the boundary holds. Attacks:
 *   OL2-PG-1  allocation ≠ consumption: two tickets allocated and both handed
 *             back unused (release_offline_ticket, the only client return) —
 *             no shot, no consumed event, lifetime_scored_count() stays 0;
 *             the returned tickets stay holds (migration §4: a return is not
 *             a re-credit, so the identity is at the paywall with two holds);
 *             double release is an idempotent replay, consume-after-release
 *             and a direct second terminal row are refused. Design note for
 *             the coordinator: an identity that returns both tickets unused
 *             has rendered zero ratings and is still at the paywall.
 *   OL2-PG-2  delayed reconciliation with a conflicting payload: the same
 *             (ticket, shot id) settled twice with DIFFERENT payloads — is the
 *             second acknowledged as a replay ('accepted') although what it
 *             carries is not what the server holds (apply_synced_shot answers
 *             shot.receipt_mismatch for this)? Does the offline settlement
 *             write ANY settlement receipt / release-policy lineage?
 *   OL2-PG-3  expired lease at settlement: a ticket whose 7-day grant expired
 *             33 days ago is presented for consumption — the hold is by
 *             design never reclaimed; the attack records whether settlement
 *             demands any execution-window evidence (it does not — the
 *             receipt path that carries it is not wired at this HEAD).
 *   OL2-PG-4  corrupted / malformed settlement payloads (bad id, score > 10,
 *             confidence > 1, captured_at garbage / out of bounds, non-numeric
 *             ms, phases not an array, missing version vector, a 'scored'
 *             shot with no score) — every one refused with a returned code
 *             (never a raised error), no shot, no ledger event, ticket still
 *             outstanding; the corrected retry then settles exactly once.
 *   OL2-PG-5  conservation under contention: 3 offline allocation lanes and
 *             3 online reservation lanes released from a barrier for one free
 *             account — outstanding tickets + live reservations never exceed
 *             the two-rating allowance, no lane raises.
 *   OL2-PG-6  account switch on one physical device: a second signed-in
 *             account cannot consume, release or see the first account's
 *             tickets even after registering the SAME installation key; the
 *             first account's tickets are untouched when it returns.
 *   OL2-PG-7  Pro leases at the table: min(7d, verified expiry) for a
 *             subscription expiring in 1h / 30d, exactly 7d for lifetime, no
 *             tickets; free tickets allocated BEFORE subscribing stay
 *             outstanding, consumable, and counted after the entitlement
 *             lapses (a lease never converts or reclaims a hold).
 *   OL2-PG-8  conflicting server state at settlement: a shot the server
 *             already holds (synced online under a permit) is presented under
 *             a ticket — never chargeable, ticket stays outstanding; the
 *             mirror (offline-settled shot re-synced online under a permit)
 *             is a replay that leaves the permit untouched.
 */
import postgres, { type JSONValue } from "postgres";
import { assert, assertEquals } from "@std/assert";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

// Distinct from every other __wf__ suite's ids and distinct per RUN: the
// ledger is append-only for every role and never reuses an account id.
const RUN = crypto.randomUUID().slice(0, 8);
const U = (n: number): string => `0000000b-0402-4000-8000-${RUN}00${String(n).padStart(2, "0")}`;
const SESSION = (n: number): string =>
  `0000000b-0402-4000-8000-${RUN}0a${String(n).padStart(2, "0")}`;
const KEY = (name: string): string => `${name}-${RUN}`;
const SUB = (name: string): string => `adv2-${name}-${RUN}`;

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
  overrides: Record<string, JSONValue | undefined> = {},
): Record<string, JSONValue> {
  const base: Record<string, JSONValue | undefined> = {
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
  const out: Record<string, JSONValue> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  return out;
}

let shotSeq = 0;
function shotId(): string {
  shotSeq += 1;
  return `0000000b-0402-4000-8000-${RUN}5${String(shotSeq).padStart(3, "0")}`;
}

type Identity = { provider: "google" | "apple"; sub: string };

/** Owner role stands in for Supabase Auth: create a user with its sign-in
 * identities and one live session. */
async function createUser(sql: Sql, n: number, identities: Identity[]): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${U(n)}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${U(n)}', 'adv2-${n}-${RUN}@example.com', '{"provider":"${
       identities[0].provider
     }"}')`,
  );
  for (const identity of identities) {
    await sql.unsafe(
      `insert into auth.identities (provider, provider_id, user_id, identity_data)
       values ('${identity.provider}', '${identity.sub}', '${U(n)}', '{"sub":"${identity.sub}"}')`,
    );
  }
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${SESSION(n)}', '${U(n)}')`);
}

/** Owner role stands in for the edge function's service-role billing write. */
async function setEntitlement(
  sql: Sql,
  n: number,
  premium: boolean,
  expiresAt: string | null,
): Promise<void> {
  await sql.unsafe(`delete from public.billing_entitlements where user_id = '${U(n)}'`);
  await sql.unsafe(
    `insert into public.billing_entitlements (user_id, premium, expires_at)
     values ('${U(n)}', ${premium}, ${expiresAt === null ? "null" : `(${expiresAt})`})`,
  );
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

function pgError(e: unknown): { code: string; message: string } {
  const err = e as { code?: string; message?: string };
  return { code: err.code ?? "?", message: err.message ?? String(e) };
}

function barrier(): { gate: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open };
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

type Grant = {
  result: string;
  grant_id: string | null;
  entitlement_source: string | null;
  lease_seconds: number | null;
  lease_matches_entitlement: boolean | null;
  ticket_ids: string[] | null;
};
async function issue(tx: Tx, key: string, requested = 2): Promise<Grant> {
  const rows = await tx.unsafe<Grant[]>(
    `select g.result, g.grant_id::text as grant_id, g.entitlement_source,
            extract(epoch from (g.expires_at - g.issued_at))::int as lease_seconds,
            (g.expires_at = g.entitlement_expires_at) as lease_matches_entitlement,
            g.ticket_ids::text[] as ticket_ids
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

type Permit = { result: string; permit_id: string | null; permit_status: string | null };
async function reserve(tx: Tx, idempotencyKey: string): Promise<Permit> {
  const rows = await tx.unsafe<Permit[]>(
    `select p.result, p.permit_id::text as permit_id, p.permit_status
     from public.reserve_analysis_permit('${idempotencyKey}') p`,
  );
  return rows[0];
}

async function sync(tx: Tx, payload: Record<string, JSONValue>): Promise<string> {
  const rows = await tx.unsafe(`select public.apply_synced_shot($1::jsonb) as r`, [
    tx.json(payload),
  ]);
  return String(rows[0].r);
}

type Access = { premium: boolean; scored_count: number; reserved_count: number; holds: number };
async function access(tx: Tx): Promise<Access> {
  const rows = await tx.unsafe<Access[]>(
    `select a.premium, a.scored_count, a.reserved_count, public.offline_hold_count() as holds
     from public.access_state() a`,
  );
  return rows[0];
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

async function setupFreeUser(sql: Sql, n: number, key: string): Promise<string[]> {
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
  name: "OL2-PG-1: allocation ≠ consumption — two tickets handed back UNUSED write no shot and no consumed event, lifetime_scored_count() stays 0, a double release is an idempotent replay, consume-after-release and a direct second terminal row are refused, and the ledger keeps exactly one terminal event per ticket",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const [t1, t2] = await setupFreeUser(sql, 1, KEY("pg1"));
      assertEquals(await inTx(sql, 1, (tx) => release(tx, t1)), "accepted");
      assertEquals(await inTx(sql, 1, (tx) => release(tx, t2)), "accepted");
      assertEquals(await ledger(sql, t1), ["allocated", "released"]);
      assertEquals(await ledger(sql, t2), ["allocated", "released"]);
      assertEquals(
        await count(sql, `select 1 from public.shots where user_id = '${U(1)}'`),
        0,
        "a return never fabricates a rating row",
      );

      const state = await inTx(sql, 1, access);
      assertEquals(state.scored_count, 0, "lifetime_scored_count() is untouched by a return");
      // Design (migration §4): a returned ticket stays a hold — returning is
      // not a re-credit. The identity is therefore at the paywall with two
      // holds and no rating; both decision points must say so with a code.
      const online = await inTx(sql, 1, (tx) => reserve(tx, KEY("pg1-online")));
      const offline = await inTx(sql, 1, (tx) => issue(tx, KEY("pg1"), 2));
      assertEquals(
        {
          online: online.result,
          offline: offline.result,
          reserved: state.reserved_count,
          holds: state.holds,
        },
        {
          online: "access.paywall_required",
          offline: "access.paywall_required",
          reserved: 2,
          holds: 2,
        },
      );

      // Repeated / double actions on terminal tickets: every path answers
      // with the ticket verdict and appends nothing.
      const sid = shotId();
      const replays = {
        releaseAgain: await inTx(sql, 1, (tx) => release(tx, t1)),
        consumeReleased: await inTx(sql, 1, (tx) => consume(tx, t1, shotPayload(sid))),
        // Direct second terminal row (superuser, bypassing the RPCs): the
        // ledger guard / partial unique index are the last line.
        directTerminal: await sql
          .unsafe(
            `insert into public.offline_allocation_ledger
               (user_id, device_id, grant_id, generation, ticket_id, event, shot_id, identity_hashes, installation_key_id)
             select user_id, device_id, grant_id, generation, ticket_id, 'consumed', '${sid}', identity_hashes, installation_key_id
             from public.offline_allocation_ledger where ticket_id = '${t1}' and event = 'allocated'`,
          )
          .then(() => "INSERTED")
          .catch((e: { code?: string }) => String(e.code)),
      };
      assertEquals(replays, {
        releaseAgain: "accepted",
        consumeReleased: "offline.ticket_released",
        directTerminal: "23514",
      });
      assertEquals(await ledger(sql, t1), ["allocated", "released"]);
      assertEquals(
        await count(sql, `select 1 from public.shots where id = '${sid}'`),
        0,
        "a refused settlement writes no shot",
      );
      assertEquals(
        (await inTx(sql, 1, access)).scored_count,
        0,
        "nothing above consumed a free rating",
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "OL2-PG-2: delayed reconciliation with conflicting server state — the same (ticket, shot id) settled twice with DIFFERENT payloads; the head's settlement-receipt contract (20260908110000) says replay is decided on the BINDING (`shot.receipt_mismatch`) and every scored settlement persists a receipt with policy lineage — the offline twin must not acknowledge a conflicting rendering as `accepted` nor settle a scored rating with no receipt",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const [t1] = await setupFreeUser(sql, 2, KEY("pg2"));
      const sid = shotId();
      const original = shotPayload(sid, {
        overallScore: 7,
        capturedAt: "2026-09-01T10:00:00.000Z",
      });
      assertEquals(await inTx(sql, 2, (tx) => consume(tx, t1, original)), "accepted");
      assertEquals(await ledger(sql, t1), ["allocated", "consumed"]);

      // A conflicting payload for the same id under the same ticket: a
      // different score, a different capture time, a different model bundle.
      const conflicting = shotPayload(sid, {
        overallScore: 3,
        capturedAt: "2026-09-02T10:00:00.000Z",
        versionVector: { ...VERSION_VECTOR, modelBundleVersion: "bundle-tampered" },
      });
      const verdict = await inTx(sql, 2, (tx) => consume(tx, t1, conflicting));
      const stored = await sql.unsafe<{ overall_score: number; model_bundle_version: string }[]>(
        `select overall_score::float8 as overall_score, model_bundle_version from public.shots where id = '${sid}'`,
      );
      assertEquals(stored[0].overall_score, 7, "the server keeps the first payload");
      assertEquals(stored[0].model_bundle_version, "bundle-1");
      assertEquals(await ledger(sql, t1), ["allocated", "consumed"], "still one terminal event");

      const receipts = await count(
        sql,
        `select 1 from public.settlement_receipts where shot_id = '${sid}'`,
      );
      assertEquals(
        { conflictingReplayVerdict: verdict, settlementReceipts: receipts },
        { conflictingReplayVerdict: "shot.receipt_mismatch", settlementReceipts: 1 },
        "apply_synced_shot() decides replay on the receipt binding (a different payload is shot.receipt_mismatch) and persists a receipt with policy lineage for every scored settlement; the offline settlement of the same rating does neither",
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "OL2-PG-3: a ticket whose 7-day grant expired 33 days ago is presented for settlement — the hold is never reclaimed (by design), and the ledger asks for no execution-window evidence: the rating is accepted and charged",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await createUser(sql, 3, [{ provider: "apple", sub: SUB("3") }]);
      const device = `0000000b-0402-4000-8000-${RUN}0d03`;
      const grant = `0000000b-0402-4000-8000-${RUN}0903`;
      const ticket = `0000000b-0402-4000-8000-${RUN}0703`;
      // Owner role: the historical rows (a device that took one ticket 40
      // days ago and never came back) — the same shape as security_regression T5.
      await sql.unsafe(
        `insert into public.offline_devices (id, user_id, installation_key_id, attestation_environment, attestation_state, attested_at)
         values ('${device}', '${U(3)}', '${KEY(
           "pg3",
         )}', 'production', 'attested', now() - interval '40 days')`,
      );
      await sql.unsafe(
        `insert into public.offline_grants (id, user_id, device_id, entitlement_source, generation, issued_at, expires_at)
         values ('${grant}', '${U(
           3,
         )}', '${device}', 'identity_lifetime_free', 1, now() - interval '40 days', now() - interval '33 days')`,
      );
      await sql.unsafe(
        `insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, identity_hashes, created_at)
         values ('${U(3)}', '${device}', '${grant}', 1, '${ticket}', 'allocated',
                 array[public.free_rating_identity_hash('apple', '${SUB(
                   "3",
                 )}')], now() - interval '40 days')`,
      );

      const before = await inTx(sql, 3, access);
      assertEquals(before.holds, 1, "the expired grant's allocation is still a hold");
      assertEquals(before.reserved_count, 1);

      const sid = shotId();
      const verdict = await inTx(sql, 3, (tx) => consume(tx, ticket, shotPayload(sid)));
      assertEquals(
        verdict,
        "accepted",
        "settlement does not consult offline_grants.expires_at nor any execution-time evidence",
      );
      assertEquals(await ledger(sql, ticket), ["allocated", "consumed"]);
      const after = await inTx(sql, 3, access);
      assertEquals(after.scored_count, 1, "the late rating is charged exactly once");
      assertEquals(after.holds, 0);
      // The remaining allowance is one rating, online or offline.
      assertEquals(after.reserved_count, 0);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "OL2-PG-4: corrupted / malformed settlement payloads — every one refused with a returned code (never raised), no shot, no ledger event, ticket still outstanding; a 'scored' shot without a score never charges; the corrected retry settles exactly once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const [t1, t2] = await setupFreeUser(sql, 4, KEY("pg4"));
      const sid = shotId();
      const attempts: Array<[string, Record<string, JSONValue>, string]> = [
        ["id not a uuid", shotPayload("not-a-uuid"), "offline.invalid_input"],
        [
          "sessionId not a uuid",
          shotPayload(sid, { sessionId: "garbage" }),
          "offline.invalid_input",
        ],
        [
          "scored with no score",
          shotPayload(sid, { overallScore: null }),
          "shot.write_failed:23514",
        ],
        [
          "score above the scale",
          shotPayload(sid, { overallScore: 11 }),
          "shot.write_failed:23514",
        ],
        ["confidence above 1", shotPayload(sid, { confidence: 2 }), "shot.write_failed:23514"],
        [
          "captured_at garbage",
          shotPayload(sid, { capturedAt: "yesterday-ish" }),
          "shot.write_failed:22007",
        ],
        [
          "captured_at before 2000",
          shotPayload(sid, { capturedAt: "1999-12-31T23:59:59.000Z" }),
          "shot.write_failed:23514",
        ],
        ["startMs not numeric", shotPayload(sid, { startMs: "x" }), "shot.write_failed:22P02"],
        [
          "phases not an array",
          shotPayload(sid, { phases: { key: "prep" } }),
          "shot.write_failed:22023",
        ],
        [
          "version vector missing",
          shotPayload(sid, { versionVector: undefined }),
          "shot.write_failed:23502",
        ],
        [
          "camera view unknown",
          shotPayload(sid, { cameraView: "drone" }),
          "shot.write_failed:23514",
        ],
        [
          "abstention under a ticket",
          shotPayload(sid, { resultKind: "low_confidence", overallScore: null }),
          "offline.shot_not_chargeable",
        ],
        [
          "partial under a ticket",
          shotPayload(sid, { resultKind: "partial", overallScore: null }),
          "offline.shot_not_chargeable",
        ],
      ];
      for (const [label, payload, expected] of attempts) {
        let verdict: string;
        try {
          verdict = await inTx(sql, 4, (tx) => consume(tx, t1, payload));
        } catch (e) {
          verdict = `RAISED ${pgError(e).code}: ${pgError(e).message}`;
        }
        assertEquals(verdict, expected, label);
        assertEquals(await ledger(sql, t1), ["allocated"], `${label}: ticket still outstanding`);
        assertEquals(
          await count(sql, `select 1 from public.shots where user_id = '${U(4)}'`),
          0,
          `${label}: nothing written`,
        );
      }
      const state = await inTx(sql, 4, access);
      assertEquals({ scored: state.scored_count, holds: state.holds }, { scored: 0, holds: 2 });

      // The corrected retry (relaunch after the failures) settles once.
      assertEquals(await inTx(sql, 4, (tx) => consume(tx, t1, shotPayload(sid))), "accepted");
      assertEquals(await inTx(sql, 4, (tx) => consume(tx, t1, shotPayload(sid))), "accepted");
      assertEquals(await ledger(sql, t1), ["allocated", "consumed"]);
      assertEquals(await count(sql, `select 1 from public.shots where id = '${sid}'`), 1);
      // The sibling ticket cannot re-settle the same rating.
      assertEquals(
        await inTx(sql, 4, (tx) => consume(tx, t2, shotPayload(sid))),
        "offline.shot_not_chargeable",
      );
      assertEquals(await ledger(sql, t2), ["allocated"]);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "OL2-PG-5: 3 offline allocation lanes + 3 online reservation lanes from one barrier for a free account — outstanding tickets + live reservations never exceed the allowance of two, no lane raises",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 10 });
    try {
      await createUser(sql, 5, [{ provider: "google", sub: SUB("5") }]);
      await inTx(sql, 5, async (tx) => {
        assertEquals((await register(tx, KEY("pg5"))).result, "accepted");
      });
      const outcome = await burst(sql, 5, 6, (tx, lane) =>
        lane % 2 === 0
          ? issue(tx, KEY("pg5"), 2).then((g) => `issue:${g.result}:${g.ticket_ids?.length ?? 0}`)
          : reserve(tx, KEY(`pg5-idem-${lane}`)).then((p) => `reserve:${p.result}`),
      );
      assertEquals(
        outcome.filter((r) => !r.ok),
        [],
        "no lane may raise",
      );
      const tickets = await count(
        sql,
        `select 1 from public.offline_allocation_ledger where user_id = '${U(
          5,
        )}' and event = 'allocated'`,
      );
      const permits = await count(
        sql,
        `select 1 from public.analysis_permits where user_id = '${U(5)}' and status = 'reserved'`,
      );
      assert(
        tickets + permits <= 2,
        `budget over-committed: ${tickets} tickets + ${permits} live permits (${JSON.stringify(
          outcome,
        )})`,
      );
      assert(tickets + permits >= 1, `nothing was handed out at all (${JSON.stringify(outcome)})`);
      const state = await inTx(sql, 5, access);
      assertEquals(state.reserved_count, tickets + permits, "access_state() sees both kinds");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "OL2-PG-6: account switch on one physical device — the second account cannot consume, release or see the first account's tickets, even after registering the SAME installation key; the first account's tickets are untouched when it returns",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const key = KEY("pg6-shared-device");
      const [a1, a2] = await setupFreeUser(sql, 6, key);
      await createUser(sql, 7, [{ provider: "apple", sub: SUB("7") }]);

      // B signs in on the same device: A's tickets are invisible and untouchable.
      assertEquals(
        await inTx(sql, 7, (tx) => consume(tx, a1, shotPayload(shotId()))),
        "offline.ticket_not_found",
      );
      assertEquals(await inTx(sql, 7, (tx) => release(tx, a1)), "offline.ticket_not_found");
      assertEquals(
        await inTx(sql, 7, (tx) =>
          count(tx as unknown as Sql, `select 1 from public.offline_allocation_ledger`),
        ),
        0,
        "B reads none of A's ledger rows through RLS",
      );
      assertEquals(
        await inTx(sql, 7, (tx) =>
          count(tx as unknown as Sql, `select 1 from public.offline_grants`),
        ),
        0,
      );
      // B registers the same installation key and allocates: B's own budget,
      // B's own tickets, A's untouched.
      await inTx(sql, 7, async (tx) => {
        assertEquals((await register(tx, key)).result, "accepted");
      });
      const b = await inTx(sql, 7, (tx) => issue(tx, key, 2));
      assertEquals(b.result, "accepted");
      assertEquals(b.ticket_ids?.length, 2);
      assert(
        !b.ticket_ids?.includes(a1) && !b.ticket_ids?.includes(a2),
        "B never receives A's tickets",
      );
      assertEquals((await inTx(sql, 7, access)).holds, 2);
      assertEquals(await ledger(sql, a1), ["allocated"]);
      assertEquals(await ledger(sql, a2), ["allocated"]);

      // B cannot settle A's ticket with B's shot, nor consume A's ticket via B's device row.
      assertEquals(
        await inTx(sql, 7, (tx) => consume(tx, a2, shotPayload(shotId()))),
        "offline.ticket_not_found",
      );

      // A returns: its refresh re-issues the same two tickets, and it settles one.
      const back = await inTx(sql, 6, (tx) => issue(tx, key, 2));
      assertEquals(back.result, "accepted");
      assertEquals([...(back.ticket_ids ?? [])].sort(), [a1, a2].sort());
      assertEquals(await inTx(sql, 6, (tx) => consume(tx, a1, shotPayload(shotId()))), "accepted");
      assertEquals((await inTx(sql, 6, access)).scored_count, 1);
      assertEquals((await inTx(sql, 7, access)).scored_count, 0, "A's rating never lands on B");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "OL2-PG-7: Pro leases at the table — min(7d, verified expiry) for a subscription expiring in 1h / 30d, exactly 7d for lifetime, never a ticket; free tickets allocated BEFORE subscribing stay outstanding, consumable and counted after the entitlement lapses",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const key = KEY("pg7");
      const [t1, t2] = await setupFreeUser(sql, 8, key);
      const SEVEN_DAYS = 7 * 24 * 60 * 60;

      // Subscribes with 1 hour left on the verified entitlement.
      await setEntitlement(sql, 8, true, "now() + interval '1 hour'");
      const short = await inTx(sql, 8, (tx) => issue(tx, key, 2));
      assertEquals(short.result, "accepted");
      assertEquals(short.entitlement_source, "verified_store");
      assertEquals(
        short.lease_matches_entitlement,
        true,
        "lease ends exactly at the verified expiry",
      );
      assert((short.lease_seconds ?? 0) <= 3600 && (short.lease_seconds ?? 0) > 3500);
      assertEquals(short.ticket_ids, [], "a Pro lease carries no tickets");

      // 30 days left: the lease is capped at 7 days.
      await setEntitlement(sql, 8, true, "now() + interval '30 days'");
      const capped = await inTx(sql, 8, (tx) => issue(tx, key, 2));
      assertEquals(capped.lease_seconds, SEVEN_DAYS);
      assertEquals(capped.lease_matches_entitlement, false);

      // Lifetime: exactly 7 days, no entitlement expiry recorded.
      await setEntitlement(sql, 8, true, null);
      const lifetime = await inTx(sql, 8, (tx) => issue(tx, key, 2));
      assertEquals(lifetime.lease_seconds, SEVEN_DAYS);
      assertEquals(lifetime.lease_matches_entitlement, null);

      // The table refuses a lease past 7d / past the entitlement (owner role, rolled back).
      for (const [label, expires, entitlement] of [
        ["8 days", "now() + interval '8 days'", "null"],
        ["past entitlement", "now() + interval '2 days'", "now() + interval '1 day'"],
      ] as const) {
        let code = "none";
        try {
          await sql.begin(async (tx) => {
            await tx.unsafe(
              `insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at)
               select '${U(8)}', d.id, 'verified_store', 99, now(), ${expires}, ${entitlement}
               from public.offline_devices d where d.installation_key_id = '${key}'`,
            );
          });
        } catch (e) {
          code = pgError(e).code;
        }
        assertEquals(code, "23514", `${label}: refused at the table`);
      }

      // The free tickets from before subscribing are untouched by the leases.
      assertEquals(await ledger(sql, t1), ["allocated"]);
      assertEquals(await ledger(sql, t2), ["allocated"]);
      assertEquals(await inTx(sql, 8, (tx) => consume(tx, t1, shotPayload(shotId()))), "accepted");

      // Entitlement lapses: the free path counts the rating and the hold.
      await setEntitlement(sql, 8, true, "now() - interval '1 second'");
      const lapsed = await inTx(sql, 8, access);
      assertEquals(
        { premium: lapsed.premium, scored: lapsed.scored_count, holds: lapsed.holds },
        { premium: false, scored: 1, holds: 1 },
      );
      const again = await inTx(sql, 8, (tx) => issue(tx, key, 2));
      assertEquals(again.result, "accepted");
      assertEquals(again.entitlement_source, "identity_lifetime_free");
      assertEquals(
        again.ticket_ids,
        [t2],
        "the refresh re-issues the outstanding ticket, never a new one",
      );
      assertEquals(
        (await inTx(sql, 8, (tx) => reserve(tx, KEY("pg7-online")))).result,
        "access.paywall_required",
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "OL2-PG-8: conflicting server state at settlement — a shot already synced online under a permit is never chargeable under a ticket (ticket stays outstanding); an offline-settled shot re-synced online is a replay that leaves the permit untouched",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const key = KEY("pg8");
      await createUser(sql, 9, [{ provider: "google", sub: SUB("9") }]);
      await inTx(sql, 9, async (tx) => {
        assertEquals((await register(tx, key)).result, "accepted");
      });
      // One online reservation first, then the offline allocation gets the rest.
      const permit = await inTx(sql, 9, (tx) => reserve(tx, KEY("pg8-online")));
      assertEquals(permit.result, "accepted");
      const grant = await inTx(sql, 9, (tx) => issue(tx, key, 2));
      assertEquals(grant.result, "accepted");
      assertEquals(grant.ticket_ids?.length, 1, "conservation: one live permit leaves one ticket");
      const [t1] = grant.ticket_ids as string[];

      // Online sync of shot S under the permit, then the same S under the ticket.
      const s = shotId();
      assertEquals(
        await inTx(sql, 9, (tx) =>
          sync(tx, { ...shotPayload(s), analysisPermitId: permit.permit_id }),
        ),
        "accepted",
      );
      assertEquals(
        await inTx(sql, 9, (tx) => consume(tx, t1, shotPayload(s))),
        "offline.shot_not_chargeable",
      );
      assertEquals(
        await ledger(sql, t1),
        ["allocated"],
        "the ticket is not spent on a rating the server holds",
      );
      let state = await inTx(sql, 9, access);
      assertEquals({ scored: state.scored_count, holds: state.holds }, { scored: 1, holds: 1 });

      // Settle a real second rating under the ticket, then re-sync it online
      // with a permit id: a replay — accepted, and the permit is not consumed.
      const s2 = shotId();
      assertEquals(await inTx(sql, 9, (tx) => consume(tx, t1, shotPayload(s2))), "accepted");
      const reSync = await inTx(sql, 9, (tx) =>
        sync(tx, { ...shotPayload(s2), analysisPermitId: permit.permit_id }),
      );
      assertEquals(reSync, "accepted", "an owned settled row replays");
      assertEquals(
        await count(
          sql,
          `select 1 from public.shots where id = '${s2}' and offline_ticket_id = '${t1}' and analysis_permit_id is null`,
        ),
        1,
        "the row still names the ticket, never the permit",
      );
      state = await inTx(sql, 9, access);
      assertEquals({ scored: state.scored_count, holds: state.holds }, { scored: 2, holds: 0 });
      assertEquals(
        (await inTx(sql, 9, (tx) => reserve(tx, KEY("pg8-third")))).result,
        "access.paywall_required",
      );
      assertEquals(
        (await inTx(sql, 9, (tx) => issue(tx, key, 2))).result,
        "access.paywall_required",
      );
    } finally {
      await sql.end();
    }
  },
});
