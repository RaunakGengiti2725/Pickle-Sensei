/**
 * W04-01 adversary round 8 — independent attacks against candidate
 * devin/pp/w04-01/impl-r7 @ 8e6e928104e08346ba6cb985cf6128245e7db139
 * (migration 20260908160000_offline_device_grants.sql). Same harness as
 * w04_01_offline_grants_concurrency.test.ts: a disposable postgres:16 with
 * shim_auth.sql + every migration applied (./xc_pg_up.sh), every client
 * statement as role `authenticated` with a JWT sub AND a live auth.sessions
 * row, nothing mocked. Owner-role statements stand in for Supabase Auth /
 * the service role and are labelled as such.
 *
 *   ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json w04_01_offline_grants_attack_r8.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
 * ignored run is NOT a pass. On BASE_SHA 6a6e92a9 every case fails (the
 * RPCs do not exist).
 *
 * Every assertion states the W04-01 objective / product invariant, not the
 * candidate's behaviour: a case that fails on the candidate is a confirmed
 * break.
 *
 * Cases:
 *   ATK-08 free-rating conservation + duplicate identities (BREAK expected):
 *          an account with two sign-in identities allocates two tickets and
 *          is deleted; the two identities re-create two accounts. The account
 *          holding identity I consumes BOTH tickets. The allocation named
 *          identity J too, yet J's lifetime ledger never moves — the account
 *          holding J reserves and scores two MORE online ratings: four scored
 *          free ratings for an identity pair entitled to two.
 *   ATK-09 free-rating conservation + late-linked identity (BREAK expected):
 *          account B (identity I) scores its two online ratings; account P
 *          (identity J) allocated two tickets and was deleted; B links J and
 *          inherits J's tickets. B's lifetime count is 2 and it holds 2 —
 *          consume_offline_ticket() settles both anyway: access_state()
 *          reports scored_count = 4 for a free account.
 *   ATK-10 boundary values — installation key length/charset, environment,
 *          requested tickets 0/-1/3/null, null/array shot payloads, reserved
 *          release reason: verdicts, never raised SQL errors.
 *   ATK-11 partial / withheld / corrupt outcomes never charge — unscored,
 *          low_confidence, NaN, non-numeric, negative, out-of-range, far-
 *          future capture, malformed dates, a foreign session, a null
 *          required column, and a settlement whose transaction dies after
 *          `accepted`: the ticket stays outstanding, no shot row exists, the
 *          hold count is unchanged, and the retry with a fresh shot settles.
 *   ATK-12 unauthorised roles — another account on the same installation key
 *          and ticket (allowed AND denied paths), authenticated without the
 *          API proof, anon, service_role, direct client writes to every
 *          offline table, api_private helpers, and a direct shots INSERT that
 *          spoofs the ticket vouch through set_config.
 *   ATK-13 Pro lease bounds — lease = min(7 days, verified entitlement
 *          expiry) for a 3-day, lifetime (null), far-future and 2-second
 *          entitlement; an expired premium falls back to the free path; the
 *          owner cannot back-date, extend, or issue a lease past the
 *          entitlement or 7 days + 1 second.
 *   ATK-14 corrupt / partially persisted state through the table owner —
 *          UPDATE/DELETE on the ledger, a consumed row naming no shot, a
 *          consumed row whose shot does not name the ticket, a terminal row
 *          for a never-allocated ticket, and a second terminal row after a
 *          support release.
 *   ATK-15 release semantics — a returned ticket is terminal, cannot be
 *          consumed, and still counts against the entitlement (no re-credit);
 *          it is never auto-reclaimed by a stale device.
 */
import postgres, { type JSONValue } from "postgres";
import { assert, assertEquals, assertNotEquals } from "@std/assert";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

// Distinct id space from every other __wf__ suite (…-a8xx-…) and per RUN:
// the ledger is append-only for every role.
const RUN = crypto.randomUUID().slice(0, 8);
const U = (n: number): string => `0000000b-a8a8-4000-8000-${RUN}00${String(n).padStart(2, "0")}`;
const SESSION = (n: number): string =>
  `0000000b-a8a8-4000-8000-${RUN}0a${String(n).padStart(2, "0")}`;
const KEY = (name: string): string => `${name}-${RUN}`;
const SUB = (name: string): string => `w04-r8-${name}-${RUN}`;

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
  return `0000000b-a8a8-4000-8000-${RUN}5${String(shotSeq).padStart(3, "0")}`;
}

type Identity = { provider: "google" | "apple"; sub: string };

/** Owner role stands in for Supabase Auth: (re)create a user with its
 * sign-in identities and one live session. */
async function createUser(sql: Sql, n: number, identities: Identity[]): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${U(n)}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${U(n)}', 'w04-r8-${n}-${RUN}@example.com', '{"provider":"${
      identities[0].provider
    }"}')`,
  );
  for (const identity of identities) {
    await linkIdentity(sql, n, identity);
  }
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${SESSION(n)}', '${U(n)}')`);
}

/** Owner role stands in for Supabase Auth linking an identity to an account
 * (fires inherit_free_rating_ledger + inherit_offline_allocation_holds). */
async function linkIdentity(sql: Sql, n: number, identity: Identity): Promise<void> {
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('${identity.provider}', '${identity.sub}', '${U(n)}', '{"sub":"${identity.sub}"}')`,
  );
}

/** Owner role stands in for account deletion (auth.users cascade). */
async function deleteUser(sql: Sql, n: number): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${U(n)}'`);
}

async function asUser(tx: Tx, n: number, apiKey = true): Promise<void> {
  if (apiKey) {
    await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
      'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  }
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

function inRole<T>(sql: Sql, role: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${role}`);
    return await fn(tx as unknown as Tx);
  }) as Promise<T>;
}

function pgError(e: unknown): { code: string; message: string } {
  const err = e as { code?: string; message?: string };
  return { code: err.code ?? "?", message: err.message ?? String(e) };
}

/** Run one statement in its own transaction and return the SQLSTATE it
 * raised ("" when it succeeded). */
async function sqlstate(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "";
  } catch (e) {
    return pgError(e).code;
  }
}

type Registration = { result: string; device_id: string | null; attestation_state: string | null };
async function register(
  tx: Tx,
  key: string | null,
  environment: string | null = "production",
  attested: boolean | null = true,
): Promise<Registration> {
  const rows = await tx.unsafe<Registration[]>(
    `select r.result, r.device_id::text as device_id, r.attestation_state
     from public.register_offline_device($1, $2, $3) r`,
    [key, environment, attested],
  );
  return rows[0];
}

type Grant = {
  result: string;
  grant_id: string | null;
  entitlement_source: string | null;
  ticket_ids: string[] | null;
  lease_seconds: number | null;
  entitlement_expires_at: string | null;
  expires_at: string | null;
};
async function issue(tx: Tx, key: string, requested: number | null = 2): Promise<Grant> {
  const rows = await tx.unsafe<Grant[]>(
    `select g.result, g.grant_id::text as grant_id, g.entitlement_source,
            g.ticket_ids::text[] as ticket_ids,
            extract(epoch from (g.expires_at - g.issued_at))::float8 as lease_seconds,
            g.entitlement_expires_at::text as entitlement_expires_at,
            g.expires_at::text as expires_at
     from public.issue_offline_grant($1, $2::int) g`,
    [key, requested],
  );
  return rows[0];
}

async function consume(
  tx: Tx,
  ticket: string | null,
  payload: JSONValue | null,
): Promise<string> {
  const rows = await tx.unsafe(
    `select public.consume_offline_ticket($1::uuid, $2::jsonb) as r`,
    [ticket, payload === null ? null : tx.json(payload)],
  );
  return String(rows[0].r);
}

async function release(
  tx: Tx,
  ticket: string,
  reason: string | null = "unused_ticket_returned",
): Promise<string> {
  const rows = await tx.unsafe(
    `select public.release_offline_ticket($1::uuid, $2) as r`,
    [ticket, reason],
  );
  return String(rows[0].r);
}

async function reserve(tx: Tx, key: string): Promise<{ result: string; permit_id: string | null }> {
  const rows = await tx.unsafe<{ result: string; permit_id: string | null }[]>(
    `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit($1) x`,
    [key],
  );
  return rows[0];
}

async function syncOnline(
  tx: Tx,
  permitId: string,
  payload: Record<string, JSONValue>,
): Promise<string> {
  const rows = await tx.unsafe(
    `select public.apply_synced_shot($1::jsonb) as r`,
    [tx.json({ ...payload, analysisPermitId: permitId })],
  );
  return String(rows[0].r);
}

type Access = { premium: boolean; scored_count: number; reserved_count: number };
async function accessState(tx: Tx): Promise<Access & { lifetime: number; holds: number }> {
  const rows = await tx.unsafe<(Access & { lifetime: number; holds: number })[]>(
    `select a.premium, a.scored_count::int as scored_count, a.reserved_count::int as reserved_count,
            public.lifetime_scored_count()::int as lifetime, public.offline_hold_count()::int as holds
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

async function ledgerCount(sql: Sql, identity: Identity): Promise<number> {
  const rows = await sql.unsafe(
    `select coalesce((select scored_count from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('${identity.provider}', '${identity.sub}')), 0)::int as n`,
  );
  return Number(rows[0].n);
}

async function setupSingleUser(
  sql: Sql,
  n: number,
  key: string,
  identities: Identity[] = [{ provider: "google", sub: SUB(String(n)) }],
): Promise<string[]> {
  await createUser(sql, n, identities);
  await inTx(sql, n, async (tx) => {
    assertEquals((await register(tx, key)).result, "accepted");
  });
  const grant = await inTx(sql, n, (tx) => issue(tx, key, 2));
  assertEquals(grant.result, "accepted");
  assertEquals(grant.ticket_ids?.length, 2);
  return grant.ticket_ids as string[];
}

Deno.test({
  name:
    "ATK-08 conservation × duplicate identities: an allocation made under identities {I, J} is consumed twice by the recovered account holding I — identity J must not be left with two fresh free ratings (allocated + consumed ≤ 2 for the identity pair)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const I: Identity = { provider: "google", sub: SUB("atk08-I") };
      const J: Identity = { provider: "apple", sub: SUB("atk08-J") };
      const key = KEY("atk08");
      // Account P (I + J) allocates two tickets on its installation, then deletes.
      const tickets = await setupSingleUser(sql, 1, key, [I, J]);
      await deleteUser(sql, 1);

      // The identities land on two accounts: B holds I, C holds J.
      await createUser(sql, 2, [I]);
      await createUser(sql, 3, [J]);

      // B recovers the installation's tickets and settles both.
      await inTx(sql, 2, async (tx) => {
        assertEquals((await register(tx, key)).result, "accepted");
        const g = await issue(tx, key, 2);
        assertEquals(g.result, "accepted");
        assertEquals([...(g.ticket_ids ?? [])].sort(), [...tickets].sort());
        assertEquals(await consume(tx, tickets[0], shotPayload(shotId())), "accepted");
        assertEquals(await consume(tx, tickets[1], shotPayload(shotId())), "accepted");
        const a = await accessState(tx);
        assertEquals(a.lifetime, 2);
        assertEquals(a.holds, 0);
      });
      assertEquals(await ledger(sql, tickets[0]), ["allocated", "consumed"]);
      assertEquals(await ledger(sql, tickets[1]), ["allocated", "consumed"]);

      // Both ratings were allocated under J as much as under I: the ledger
      // must carry them for J exactly as shots_record_free_rating_ledger
      // would have had P scored them online (every identity of the account).
      const jLedger = await ledgerCount(sql, J);
      const iLedger = await ledgerCount(sql, I);
      assertEquals(iLedger, 2, "identity I is charged for the two settled tickets");

      // C (identity J) must see the pair's entitlement as spent.
      const c = await inTx(sql, 3, async (tx) => {
        const before = await accessState(tx);
        const r1 = await reserve(tx, KEY("atk08-c1"));
        const r2 = await reserve(tx, KEY("atk08-c2"));
        let synced = 0;
        for (const r of [r1, r2]) {
          if (r.result === "accepted" && r.permit_id) {
            if ((await syncOnline(tx, r.permit_id, shotPayload(shotId()))) === "accepted") {
              synced += 1;
            }
          }
        }
        const after = await accessState(tx);
        return { before, r1: r1.result, r2: r2.result, synced, after };
      });
      const cShots = await count(
        sql,
        `select 1 from public.shots where user_id = '${U(3)}' and result_kind = 'scored'`,
      );
      const pairScored = 2 + cShots;
      assert(
        jLedger >= 2 && c.r1 === "access.paywall_required" && c.r2 === "access.paywall_required" &&
          c.synced === 0 && pairScored <= 2,
        `identity pair {I, J} was entitled to 2 free ratings; observed: J ledger=${jLedger} (I=${iLedger}), ` +
          `C access before=${
            JSON.stringify(c.before)
          } reserve=[${c.r1}, ${c.r2}] synced=${c.synced} ` +
          `after=${JSON.stringify(c.after)}; scored ratings across the pair=${pairScored}`,
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATK-09 conservation × late-linked identity: an account whose lifetime_scored_count() is already 2 inherits two outstanding tickets by linking an identity — settling them must not push a free account to four scored ratings",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const I: Identity = { provider: "google", sub: SUB("atk09-I") };
      const J: Identity = { provider: "apple", sub: SUB("atk09-J") };
      const key = KEY("atk09");
      // P (J) allocates two tickets and is deleted.
      const tickets = await setupSingleUser(sql, 4, key, [J]);
      await deleteUser(sql, 4);

      // B (I) spends its two online ratings the ordinary way.
      await createUser(sql, 5, [I]);
      await inTx(sql, 5, async (tx) => {
        const p1 = await reserve(tx, KEY("atk09-b1"));
        const p2 = await reserve(tx, KEY("atk09-b2"));
        assertEquals(p1.result, "accepted");
        assertEquals(p2.result, "accepted");
        assertEquals(
          await syncOnline(tx, p1.permit_id as string, shotPayload(shotId())),
          "accepted",
        );
        assertEquals(
          await syncOnline(tx, p2.permit_id as string, shotPayload(shotId())),
          "accepted",
        );
        const a = await accessState(tx);
        assertEquals(a.lifetime, 2);
        assertEquals((await reserve(tx, KEY("atk09-b3"))).result, "access.paywall_required");
      });

      // B links J: inherit_free_rating_ledger (J := 2) + inherit_offline_allocation_holds.
      await linkIdentity(sql, 5, J);
      assertEquals(await ledgerCount(sql, J), 2, "late link inherits the account's lifetime count");

      const outcome = await inTx(sql, 5, async (tx) => {
        const before = await accessState(tx);
        assertEquals((await register(tx, key)).result, "accepted");
        const g = await issue(tx, key, 2);
        const c1 = await consume(tx, tickets[0], shotPayload(shotId()));
        const c2 = await consume(tx, tickets[1], shotPayload(shotId()));
        const after = await accessState(tx);
        return { before, issue: g.result, issued: g.ticket_ids?.length ?? 0, c1, c2, after };
      });
      const scoredShots = await count(
        sql,
        `select 1 from public.shots where user_id = '${U(5)}' and result_kind = 'scored'`,
      );
      // Objective: allocated + consumed + released ≤ entitlement (2). The
      // holds are never reclaimed, so the only conforming outcomes are a
      // refused settlement (ticket stays outstanding for release) or a
      // scored count that stays within the allowance.
      assert(
        outcome.after.scored_count <= 2 && scoredShots <= 2,
        `free account exceeded the lifetime allowance: before=${JSON.stringify(outcome.before)} ` +
          `issue=${outcome.issue}/${outcome.issued} consume=[${outcome.c1}, ${outcome.c2}] ` +
          `after=${JSON.stringify(outcome.after)} scored shots=${scoredShots}`,
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATK-10 boundary values: installation key 128/129/empty/null/leading-dot/unicode, environment staging/null, requested tickets 3/-1/null/0, null or non-object shot, reserved and null release reasons — every one a verdict, never a raised SQL error",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      const key = KEY("atk10");
      await createUser(sql, 6, [{ provider: "google", sub: SUB("atk10") }]);
      await inTx(sql, 6, async (tx) => {
        assertEquals((await register(tx, "a".repeat(128))).result, "accepted");
        assertEquals((await register(tx, "a".repeat(129))).result, "offline.invalid_input");
        assertEquals((await register(tx, "")).result, "offline.invalid_input");
        assertEquals((await register(tx, null)).result, "offline.invalid_input");
        assertEquals((await register(tx, ".abc")).result, "offline.invalid_input");
        assertEquals((await register(tx, "abc\u00e9")).result, "offline.invalid_input");
        assertEquals((await register(tx, key, "staging")).result, "offline.invalid_input");
        assertEquals((await register(tx, key, "production", null)).result, "offline.invalid_input");
        assertEquals((await register(tx, key)).result, "accepted");
        assertEquals(
          (await register(tx, key, "development")).result,
          "offline.device_environment_mismatch",
        );
        const downgrade = await register(tx, key, "production", false);
        assertEquals(downgrade.result, "accepted");
        assertEquals(downgrade.attestation_state, "attested", "attestation is never downgraded");

        assertEquals((await issue(tx, key, 3)).result, "offline.invalid_input");
        assertEquals((await issue(tx, key, -1)).result, "offline.invalid_input");
        assertEquals((await issue(tx, key, null)).result, "offline.invalid_input");
        assertEquals((await issue(tx, key, 0)).result, "offline.invalid_input");
        assertEquals(
          (await issue(tx, KEY("atk10-unregistered"), 2)).result,
          "offline.device_not_registered",
        );
        const one = await issue(tx, key, 1);
        assertEquals(one.result, "accepted");
        assertEquals(one.ticket_ids?.length, 1);
        assertEquals(one.lease_seconds, 7 * 24 * 3600, "free lease is exactly 7 days");
        const zeroWithOutstanding = await issue(tx, key, 0);
        assertEquals(zeroWithOutstanding.result, "accepted");
        assertEquals(zeroWithOutstanding.ticket_ids, one.ticket_ids);

        assertEquals(await consume(tx, null, shotPayload(shotId())), "offline.invalid_input");
        assertEquals(await consume(tx, crypto.randomUUID(), null), "offline.invalid_input");
        assertEquals(await consume(tx, crypto.randomUUID(), []), "offline.invalid_input");
        assertEquals(await consume(tx, crypto.randomUUID(), "scored"), "offline.invalid_input");
        assertEquals(
          await consume(tx, crypto.randomUUID(), shotPayload(shotId())),
          "offline.ticket_not_found",
        );
        assertEquals(
          await consume(tx, crypto.randomUUID(), shotPayload("not-a-uuid")),
          "offline.invalid_input",
        );
        assertEquals(
          await release(tx, crypto.randomUUID(), "support_review"),
          "offline.invalid_input",
        );
        assertEquals(await release(tx, crypto.randomUUID(), null), "offline.invalid_input");
        assertEquals(await release(tx, crypto.randomUUID(), ""), "offline.invalid_input");
        assertEquals(await release(tx, crypto.randomUUID()), "offline.ticket_not_found");
      });
      // Unattested device: registered, no grant.
      await inTx(sql, 6, async (tx) => {
        const r = await register(tx, KEY("atk10-unattested"), "production", false);
        assertEquals(r.result, "accepted");
        assertEquals(r.attestation_state, "unattested");
        assertEquals(
          (await issue(tx, KEY("atk10-unattested"), 2)).result,
          "offline.device_not_attested",
        );
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATK-11 partial / withheld / corrupt outcomes never charge: abstentions, NaN, non-numeric, negative and out-of-range scores, far-future and malformed capture times, a foreign session, a null required column and a settlement whose transaction dies after `accepted` — the ticket stays outstanding, no shot row exists, and the clean retry settles",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      const key = KEY("atk11");
      const [t1, t2] = await setupSingleUser(sql, 7, key);
      const attempts: Array<[string, Record<string, JSONValue>]> = [
        ["unscored", { resultKind: "unscored", overallScore: null }],
        ["low_confidence", { resultKind: "low_confidence", overallScore: null }],
        ["resultKind null", { resultKind: null }],
        ["NaN score", { overallScore: "NaN" }],
        ["non-numeric score", { overallScore: "abc" }],
        ["negative score", { overallScore: -5 }],
        ["out-of-range score", { overallScore: 1e10 }],
        ["far-future capture", { capturedAt: "9999-12-31T00:00:00Z" }],
        ["malformed capture", { capturedAt: "not-a-date" }],
        ["NaN startMs", { startMs: "NaN" }],
        ["foreign session", { sessionId: crypto.randomUUID() }],
        ["null shot type", { shotType: null }],
        ["version vector missing", { versionVector: null }],
        ["phases not an array", { phases: { key: "x" } }],
      ];
      const verdicts: Record<string, string> = {};
      for (const [label, overrides] of attempts) {
        verdicts[label] = await inTx(
          sql,
          7,
          (tx) => consume(tx, t1, shotPayload(shotId(), overrides)),
        );
      }
      for (const [label, verdict] of Object.entries(verdicts)) {
        assertNotEquals(verdict, "accepted", `${label} must not settle the ticket`);
        assert(
          verdict.startsWith("offline.") || verdict.startsWith("shot."),
          `${label}: verdict must be a stable code, got ${verdict}`,
        );
      }
      assertEquals(verdicts["unscored"], "offline.shot_not_chargeable");
      assertEquals(verdicts["low_confidence"], "offline.shot_not_chargeable");
      assertEquals(verdicts["foreign session"], "shot.session_not_found");
      assertEquals(await ledger(sql, t1), ["allocated"]);
      assertEquals(await count(sql, `select 1 from public.shots where user_id = '${U(7)}'`), 0);
      assertEquals(
        await count(sql, `select 1 from public.shot_phases where user_id = '${U(7)}'`),
        0,
        "no detail row survives a refused settlement",
      );

      // Process death after `accepted` but before COMMIT: nothing persists.
      const lostShot = shotId();
      await sql.begin(async (raw) => {
        const tx = raw as unknown as Tx;
        await asUser(tx, 7);
        assertEquals(await consume(tx, t1, shotPayload(lostShot)), "accepted");
        throw new Error("simulated process death before commit");
      }).catch((e: unknown) => {
        if (!(e instanceof Error) || !e.message.includes("simulated process death")) throw e;
      });
      assertEquals(await ledger(sql, t1), ["allocated"]);
      assertEquals(await count(sql, `select 1 from public.shots where id = '${lostShot}'`), 0);
      await inTx(sql, 7, async (tx) => {
        const a = await accessState(tx);
        assertEquals(a.holds, 2, "both tickets still outstanding");
        assertEquals(a.lifetime, 0);
        // Restart: the device retries with the shot it rendered.
        assertEquals(await consume(tx, t1, shotPayload(lostShot)), "accepted");
        assertEquals(await consume(tx, t1, shotPayload(lostShot)), "accepted", "idempotent replay");
        assertEquals(await consume(tx, t1, shotPayload(shotId())), "offline.ticket_consumed");
        // The same rendered shot cannot be charged to the sibling ticket.
        assertEquals(await consume(tx, t2, shotPayload(lostShot)), "offline.shot_not_chargeable");
        const b = await accessState(tx);
        assertEquals(b.lifetime, 1);
        assertEquals(b.holds, 1);
      });
      assertEquals(await ledger(sql, t1), ["allocated", "consumed"]);
      assertEquals(await ledger(sql, t2), ["allocated"]);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATK-12 unauthorised roles: another account on the same installation key / ticket, authenticated without the API proof, anon, service_role, direct client writes to every offline table and helper, and a spoofed ticket vouch on a direct shots INSERT",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      const key = KEY("atk12");
      const [t1] = await setupSingleUser(sql, 8, key);
      await createUser(sql, 9, [{ provider: "google", sub: SUB("atk12-other") }]);

      // Another account signs in on the SAME installation (interleaved
      // account switch): its own row, its own tickets, nothing of user 8.
      await inTx(sql, 9, async (tx) => {
        assertEquals(await consume(tx, t1, shotPayload(shotId())), "offline.ticket_not_found");
        assertEquals(await release(tx, t1), "offline.ticket_not_found");
        assertEquals((await register(tx, key)).result, "accepted");
        const g = await issue(tx, key, 2);
        assertEquals(g.result, "accepted");
        assertEquals(g.ticket_ids?.length, 2);
        assert(!(g.ticket_ids ?? []).includes(t1), "a stranger's ticket is never re-issued");
        assertEquals(
          await count(
            sql,
            `select 1 from public.offline_allocation_ledger where user_id = '${U(8)}'`,
          ) > 0,
          true,
        );
        for (const table of ["offline_devices", "offline_grants", "offline_allocation_ledger"]) {
          const rows = await tx.unsafe(
            `select count(*)::int as n from public.${table} where user_id = '${U(8)}'`,
          );
          assertEquals(Number(rows[0].n), 0, `${table}: RLS hides the other account's rows`);
        }
      });
      assertEquals(await ledger(sql, t1), ["allocated"]);

      // authenticated WITHOUT the API proof: every RPC refuses with 42501,
      // the counters answer 0 / refuse, the tables are invisible.
      const noKey = <T>(fn: (tx: Tx) => Promise<T>) =>
        sql.begin(async (raw) => {
          await asUser(raw as unknown as Tx, 8, false);
          return await fn(raw as unknown as Tx);
        }) as Promise<T>;
      assertEquals(await sqlstate(() => noKey((tx) => register(tx, key))), "42501");
      assertEquals(await sqlstate(() => noKey((tx) => issue(tx, key, 2))), "42501");
      assertEquals(
        await sqlstate(() => noKey((tx) => consume(tx, t1, shotPayload(shotId())))),
        "42501",
      );
      assertEquals(await sqlstate(() => noKey((tx) => release(tx, t1))), "42501");
      assertEquals(
        Number(
          (await noKey((tx) => tx.unsafe(`select public.offline_hold_count()::int as n`)))[0].n,
        ),
        0,
      );
      assertEquals(
        Number(
          (await noKey((tx) =>
            tx.unsafe(`select count(*)::int as n from public.offline_allocation_ledger`)
          ))[0].n,
        ),
        0,
      );

      // anon and service_role: no EXECUTE on the RPCs or helpers, no table access.
      for (const role of ["anon", "service_role"]) {
        assertEquals(
          await sqlstate(() => inRole(sql, role, (tx) => register(tx, key))),
          "42501",
          `${role} register`,
        );
        assertEquals(
          await sqlstate(() => inRole(sql, role, (tx) => issue(tx, key, 2))),
          "42501",
          `${role} issue`,
        );
        assertEquals(
          await sqlstate(() => inRole(sql, role, (tx) => consume(tx, t1, shotPayload(shotId())))),
          "42501",
          `${role} consume`,
        );
        assertEquals(
          await sqlstate(() => inRole(sql, role, (tx) => release(tx, t1))),
          "42501",
          `${role} release`,
        );
        assertEquals(
          await sqlstate(() =>
            inRole(sql, role, (tx) => tx.unsafe(`select public.offline_hold_count()`))
          ),
          "42501",
          `${role} offline_hold_count`,
        );
        assertEquals(
          await sqlstate(() =>
            inRole(sql, role, (tx) => tx.unsafe(`select public.online_reservation_count()`))
          ),
          "42501",
          `${role} online_reservation_count`,
        );
        for (
          const table of [
            "offline_devices",
            "offline_grants",
            "offline_allocation_ledger",
            "offline_allocation_identity_links",
          ]
        ) {
          assertEquals(
            await sqlstate(() =>
              inRole(sql, role, (tx) => tx.unsafe(`select count(*) from public.${table}`))
            ),
            "42501",
            `${role} select ${table}`,
          );
        }
        assertEquals(
          await sqlstate(() =>
            inRole(sql, role, (tx) =>
              tx.unsafe(
                `insert into public.offline_allocation_ledger
                   (user_id, device_id, grant_id, generation, ticket_id, event, reason, identity_hashes, installation_key_id)
                 values ('${
                  U(8)
                }', gen_random_uuid(), gen_random_uuid(), 1, '${t1}', 'released', 'support_review', '{}', '${key}')`,
              ))
          ),
          "42501",
          `${role} insert ledger`,
        );
        assertEquals(
          await sqlstate(() =>
            inRole(
              sql,
              role,
              (tx) =>
                tx.unsafe(
                  `update public.offline_grants set expires_at = now() + interval '30 days'`,
                ),
            )
          ),
          "42501",
          `${role} update grants`,
        );
      }

      // authenticated WITH the proof: the tables are read-only and the
      // helpers are not callable.
      const denied: Array<[string, string]> = [
        [
          "insert ledger",
          `insert into public.offline_allocation_ledger
             (user_id, device_id, grant_id, generation, ticket_id, event, identity_hashes, installation_key_id)
           values ('${
            U(8)
          }', gen_random_uuid(), gen_random_uuid(), 1, gen_random_uuid(), 'allocated', '{}', '${key}')`,
        ],
        [
          "update ledger",
          `update public.offline_allocation_ledger set event = 'released' where ticket_id = '${t1}'`,
        ],
        ["delete ledger", `delete from public.offline_allocation_ledger where ticket_id = '${t1}'`],
        [
          "insert device",
          `insert into public.offline_devices (user_id, installation_key_id, attestation_environment, attestation_state)
           values ('${U(8)}', 'hax', 'production', 'attested')`,
        ],
        [
          "update device",
          `update public.offline_devices set attestation_state = 'attested' where user_id = '${
            U(8)
          }'`,
        ],
        ["delete device", `delete from public.offline_devices where user_id = '${U(8)}'`],
        [
          "update grant",
          `update public.offline_grants set expires_at = now() + interval '30 days' where user_id = '${
            U(8)
          }'`,
        ],
        ["delete grant", `delete from public.offline_grants where user_id = '${U(8)}'`],
        [
          "insert grant",
          `insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at)
           select user_id, id, 'verified_store', 9, now(), now() + interval '7 days' from public.offline_devices where user_id = '${
            U(8)
          }'`,
        ],
        ["select links", `select count(*) from public.offline_allocation_identity_links`],
        [
          "insert link",
          `insert into public.offline_allocation_identity_links (ticket_id, identity_hash, user_id)
           values ('${t1}', repeat('a', 64), '${U(8)}')`,
        ],
        ["lock key", `select api_private.offline_ticket_lock_key('${t1}')`],
        ["identity hashes", `select api_private.offline_identity_hashes('${U(8)}')`],
        ["owned allocations", `select api_private.offline_owned_allocations('${U(8)}')`],
        [
          "owned_by",
          `select api_private.offline_ticket_owned_by('${U(8)}', '{}', '${t1}', '${U(8)}')`,
        ],
        ["get_api_request_key", `select public.get_api_request_key()`],
      ];
      for (const [label, statement] of denied) {
        assertEquals(
          await sqlstate(() => inTx(sql, 8, (tx) => tx.unsafe(statement))),
          "42501",
          label,
        );
      }

      // Direct scored INSERT naming the ticket, with and without a spoofed
      // vouch: refused; the ticket stays outstanding.
      const directInsert = (vouch: boolean) =>
        inTx(sql, 8, async (tx) => {
          if (vouch) {
            await tx.unsafe(`select set_config('pickle.offline_ticket_id', '${t1}', true)`);
          }
          await tx.unsafe(
            `insert into public.shots (id, user_id, offline_ticket_id, shot_type, camera_view, captured_at,
               start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind, source)
             values ('${shotId()}', '${
              U(8)
            }', '${t1}', 'dink', 'side', now(), 0, 100, 200, 7, 0.9, 'scored', 'real')`,
          );
        });
      assertEquals(await sqlstate(() => directInsert(false)), "42501");
      const spoofed = await sqlstate(() => directInsert(true));
      assertNotEquals(spoofed, "", "a spoofed vouch on a direct INSERT must be refused");
      assertEquals(await ledger(sql, t1), ["allocated"]);
      assertEquals(
        await count(sql, `select 1 from public.shots where offline_ticket_id = '${t1}'`),
        0,
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATK-13 Pro lease bounds: min(7 days, verified entitlement expiry) for a 3-day, lifetime, far-future and 2-second entitlement; an expired premium is the free path; the owner cannot issue past the entitlement or past 7 days, or mutate a lease",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      const key = KEY("atk13");
      await createUser(sql, 10, [{ provider: "apple", sub: SUB("atk13") }]);
      // Owner role stands in for the edge function's service-role billing write.
      const setEntitlement = (premium: boolean, expires: string | null) =>
        sql.unsafe(
          `insert into public.billing_entitlements (user_id, premium, expires_at)
           values ('${U(10)}', ${premium}, ${expires === null ? "null" : expires})
           on conflict (user_id) do update set premium = excluded.premium, expires_at = excluded.expires_at,
             verified_at = now(), verification_order = public.billing_entitlements.verification_order + 1`,
        );
      await inTx(sql, 10, async (tx) => {
        assertEquals((await register(tx, key)).result, "accepted");
      });

      await setEntitlement(true, `now() + interval '3 days'`);
      const threeDay = await inTx(sql, 10, (tx) => issue(tx, key, 2));
      assertEquals(threeDay.result, "accepted");
      assertEquals(threeDay.entitlement_source, "verified_store");
      assertEquals(threeDay.ticket_ids, [], "a Pro lease carries no tickets");
      assert(
        (threeDay.lease_seconds ?? 0) <= 3 * 24 * 3600 &&
          (threeDay.lease_seconds ?? 0) > 3 * 24 * 3600 - 5,
        `lease bounded by the 3-day entitlement, got ${threeDay.lease_seconds}s`,
      );
      assertEquals(threeDay.expires_at, threeDay.entitlement_expires_at);

      await setEntitlement(true, null);
      const lifetime = await inTx(sql, 10, (tx) => issue(tx, key, 2));
      assertEquals(lifetime.result, "accepted");
      assertEquals(lifetime.lease_seconds, 7 * 24 * 3600);
      assertEquals(lifetime.entitlement_expires_at, null);

      await setEntitlement(true, `'9999-12-31T00:00:00Z'`);
      const farFuture = await inTx(sql, 10, (tx) => issue(tx, key, 2));
      assertEquals(farFuture.result, "accepted");
      assertEquals(
        farFuture.lease_seconds,
        7 * 24 * 3600,
        "a far-future entitlement never extends a lease past 7 days",
      );

      await setEntitlement(true, `now() + interval '2 seconds'`);
      const tiny = await inTx(sql, 10, (tx) => issue(tx, key, 2));
      assertEquals(tiny.result, "accepted");
      assert(
        (tiny.lease_seconds ?? 99) <= 2,
        `lease bounded by a 2-second entitlement, got ${tiny.lease_seconds}s`,
      );

      await setEntitlement(true, `now() - interval '1 second'`);
      const expired = await inTx(sql, 10, async (tx) => {
        const g = await issue(tx, key, 2);
        return { g, a: await accessState(tx) };
      });
      assertEquals(expired.g.result, "accepted");
      assertEquals(
        expired.g.entitlement_source,
        "identity_lifetime_free",
        "a stored premium past expires_at is not premium",
      );
      assertEquals(expired.g.ticket_ids?.length, 2);
      assertEquals(expired.a.premium, false);

      // Owner-role corruption attempts on the grants table.
      const deviceId = String(
        (await sql.unsafe(
          `select id from public.offline_devices where user_id = '${
            U(10)
          }' and installation_key_id = '${key}'`,
        ))[0].id,
      );
      await setEntitlement(true, `now() + interval '3 days'`);
      const ownerInsert = (source: string, lease: string, entitlement: string) =>
        sql.unsafe(
          `insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at)
           values ('${
            U(10)
          }', '${deviceId}', '${source}', 99, now(), now() + ${lease}, ${entitlement})`,
        );
      assertNotEquals(
        await sqlstate(() =>
          ownerInsert("verified_store", `interval '4 days'`, `now() + interval '3 days'`)
        ),
        "",
        "lease past the entitlement",
      );
      assertNotEquals(
        await sqlstate(() => ownerInsert("verified_store", `interval '7 days 1 second'`, `null`)),
        "",
        "lease past 7 days",
      );
      assertNotEquals(
        await sqlstate(() =>
          ownerInsert("verified_store", `interval '1 day'`, `now() + interval '10 days'`)
        ),
        "",
        "entitlement expiry that is not the verified one",
      );
      assertNotEquals(
        await sqlstate(() =>
          ownerInsert("identity_lifetime_free", `interval '7 days 1 second'`, `null`)
        ),
        "",
        "free lease past 7 days",
      );
      assertNotEquals(
        await sqlstate(() => ownerInsert("identity_lifetime_free", `interval '-1 second'`, `null`)),
        "",
        "lease ending before issue",
      );
      await setEntitlement(false, null);
      assertNotEquals(
        await sqlstate(() => ownerInsert("verified_store", `interval '1 day'`, `null`)),
        "",
        "Pro lease without an effective entitlement",
      );
      assertNotEquals(
        await sqlstate(() =>
          sql.unsafe(
            `update public.offline_grants set expires_at = issued_at + interval '30 days' where user_id = '${
              U(10)
            }'`,
          )
        ),
        "",
        "leases are immutable",
      );
      assertNotEquals(
        await sqlstate(() =>
          sql.unsafe(
            `update public.offline_grants set issued_at = issued_at - interval '30 days' where user_id = '${
              U(10)
            }'`,
          )
        ),
        "",
        "leases cannot be back-dated",
      );
      const rows = await sql.unsafe(
        `select count(*)::int as n from public.offline_grants
         where user_id = '${U(10)}' and (expires_at > issued_at + interval '7 days'
           or (entitlement_expires_at is not null and expires_at > entitlement_expires_at))`,
      );
      assertEquals(Number(rows[0].n), 0, "no persisted lease exceeds 7 days or its entitlement");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATK-14 corrupt / partially persisted state through the table owner: ledger UPDATE/DELETE, a consumed row without a shot, a consumed row whose shot does not name the ticket, a terminal row for a never-allocated ticket, a second terminal after a support release, and an unknown reason — all refused",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      const key = KEY("atk14");
      const [t1, t2] = await setupSingleUser(sql, 11, key);
      const alloc =
        `(select user_id, device_id, grant_id, generation, identity_hashes, installation_key_id
                      from public.offline_allocation_ledger where ticket_id = '${t1}' and event = 'allocated')`;
      const owner = (statement: string) => sqlstate(() => sql.unsafe(statement));

      assertNotEquals(
        await owner(
          `update public.offline_allocation_ledger set identity_hashes = '{}' where ticket_id = '${t1}'`,
        ),
        "",
      );
      assertNotEquals(
        await owner(
          `update public.offline_allocation_ledger set event = 'released', reason = 'support_review' where ticket_id = '${t1}'`,
        ),
        "",
      );
      assertNotEquals(
        await owner(`delete from public.offline_allocation_ledger where ticket_id = '${t1}'`),
        "",
      );
      assertNotEquals(
        await owner(
          `insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, identity_hashes, installation_key_id)
           select user_id, device_id, grant_id, generation, '${t1}', 'consumed', identity_hashes, installation_key_id from ${alloc} a`,
        ),
        "",
        "consumed without a shot",
      );
      assertNotEquals(
        await owner(
          `insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id, identity_hashes, installation_key_id)
           select user_id, device_id, grant_id, generation, '${t1}', 'consumed', gen_random_uuid(), identity_hashes, installation_key_id from ${alloc} a`,
        ),
        "",
        "consumed naming a shot that does not name the ticket",
      );
      assertNotEquals(
        await owner(
          `insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, identity_hashes, installation_key_id)
           values ('${
            U(11)
          }', gen_random_uuid(), gen_random_uuid(), 1, gen_random_uuid(), 'released', 'support_review', '{}', '${key}')`,
        ),
        "",
        "terminal row for a ticket never allocated",
      );
      assertNotEquals(
        await owner(
          `insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, identity_hashes, installation_key_id)
           select user_id, device_id, grant_id, generation, '${t1}', 'released', 'because', identity_hashes, installation_key_id from ${alloc} a`,
        ),
        "",
        "unknown release reason",
      );
      assertNotEquals(
        await owner(
          `insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, identity_hashes, installation_key_id)
           select user_id, device_id, grant_id, generation, '${t1}', 'allocated', identity_hashes, installation_key_id from ${alloc} a`,
        ),
        "",
        "second allocation of one ticket",
      );
      assertEquals(await ledger(sql, t1), ["allocated"]);

      // Support review through the table (the documented support path) …
      assertEquals(
        await owner(
          `insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, identity_hashes, installation_key_id)
           select user_id, device_id, grant_id, generation, '${t1}', 'released', 'support_review', identity_hashes, installation_key_id from ${alloc} a`,
        ),
        "",
      );
      // … then every second terminal row is impossible for the owner too.
      assertNotEquals(
        await owner(
          `insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, identity_hashes, installation_key_id)
           select user_id, device_id, grant_id, generation, '${t1}', 'released', 'unused_ticket_returned', identity_hashes, installation_key_id from ${alloc} a`,
        ),
        "",
      );
      assertEquals(await ledger(sql, t1), ["allocated", "released"]);
      await inTx(sql, 11, async (tx) => {
        assertEquals(await consume(tx, t1, shotPayload(shotId())), "offline.ticket_released");
        assertEquals(
          await release(tx, t1),
          "accepted",
          "release is idempotent over a support release",
        );
        const a = await accessState(tx);
        assertEquals(a.holds, 2, "a released ticket still counts against the entitlement");
        assertEquals(await consume(tx, t2, shotPayload(shotId())), "accepted");
      });
      assertEquals(await ledger(sql, t1), ["allocated", "released"]);
      assertEquals(await ledger(sql, t2), ["allocated", "consumed"]);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATK-15 release semantics + no auto-reclaim: a returned ticket is terminal, cannot be consumed, is not re-credited (the identity stays at its allowance), and a disconnected device's tickets survive account deletion, expiry of the grant and re-registration untouched",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      const key = KEY("atk15");
      const I: Identity = { provider: "google", sub: SUB("atk15") };
      const [t1, t2] = await setupSingleUser(sql, 12, key, [I]);
      await inTx(sql, 12, async (tx) => {
        assertEquals(await release(tx, t1), "accepted");
        assertEquals(await release(tx, t1), "accepted", "idempotent");
        assertEquals(await consume(tx, t1, shotPayload(shotId())), "offline.ticket_released");
        const a = await accessState(tx);
        assertEquals(a.lifetime, 0);
        assertEquals(a.holds, 2, "a released ticket is not a re-credit");
        assertEquals(a.reserved_count, 2);
        assertEquals((await reserve(tx, KEY("atk15-r1"))).result, "access.paywall_required");
        const g = await issue(tx, key, 2);
        assertEquals(g.result, "accepted");
        assertEquals(
          g.ticket_ids,
          [t2],
          "only the outstanding ticket is re-issued; nothing new is minted",
        );
      });

      // Owner role stands in for the pg_cron / a stale-lease sweep that does
      // NOT exist: even after the grant's lease is (simulated) long past and
      // the account is deleted, the allocation is still there.
      await sql.unsafe(`delete from auth.users where id = '${U(12)}'`);
      assertEquals(
        await ledger(sql, t2),
        ["allocated"],
        "never auto-reclaimed on disconnect / deletion",
      );
      assertEquals(
        await count(sql, `select 1 from public.offline_grants where user_id = '${U(12)}'`),
        0,
        "grants cascade with the device",
      );
      assertEquals(
        await count(sql, `select 1 from public.offline_devices where user_id = '${U(12)}'`),
        0,
      );

      // Same identity returns: the hold is still its own.
      await createUser(sql, 13, [I]);
      await inTx(sql, 13, async (tx) => {
        const a = await accessState(tx);
        assertEquals(a.holds, 2, "released + outstanding both still count for the identity");
        assertEquals((await reserve(tx, KEY("atk15-r2"))).result, "access.paywall_required");
        assertEquals((await register(tx, key)).result, "accepted");
        const g = await issue(tx, key, 2);
        assertEquals(g.result, "accepted");
        assertEquals(g.ticket_ids, [t2]);
        assertEquals(await consume(tx, t2, shotPayload(shotId())), "accepted");
        assertEquals(await release(tx, t2), "offline.ticket_consumed");
        const b = await accessState(tx);
        assertEquals(b.lifetime, 1);
        assertEquals(b.holds, 1);
        assertEquals(
          b.scored_count + b.reserved_count,
          2,
          "allocated + consumed + released = entitlement",
        );
        assertEquals((await reserve(tx, KEY("atk15-r3"))).result, "access.paywall_required");
      });
      assertEquals(await ledger(sql, t1), ["allocated", "released"]);
      assertEquals(await ledger(sql, t2), ["allocated", "consumed"]);
    } finally {
      await sql.end();
    }
  },
});
