/**
 * INT-charging-permits adversary (pass 2) — the DATABASE side of the charge
 * boundary at HEAD 2994371e1c5edf9a1e9bb12f6c6e4751e3fb4ea1, against a REAL
 * disposable Postgres with every migration applied. Every call runs as role
 * `authenticated` with a live session claim, exactly as PostgREST would run
 * it for the edge function; owner-role statements only stand in for Supabase
 * Auth (users / sessions / entitlements) and for pg_cron.
 *
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json xc_pg_adv2_charging_permits.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
 * ignored run is NOT a pass.
 *
 * Attacks (ADV2-P*), each distinct from the lifecycle / terminal / rpc
 * concurrency / W04-01 suites already on this head:
 *   P1  offline allocation vs online consumption: a held ticket is a rating
 *       the free slot must leave room for; releasing the ticket never
 *       resurrects the permit the backstop already closed.
 *   P2  partial is terminal at the database: released/partial cannot be
 *       upgraded by a later scored shot, nor by replaying the same id with
 *       resultKind flipped to scored; nothing counts.
 *   P3  late sync onto an expired reservation: the approved settlements land
 *       WITHOUT rewriting permit metadata; an expired permit consumed once
 *       stays consumed.
 *   P4  premium bypass boundary: a stored premium row past its expires_at is
 *       NOT premium (allowance enforced); a live one is (third rating admitted).
 *   P5  session boundary is HOLD, not a dead end: a shot naming another
 *       account's session is refused, the permit still backs a clean retry.
 *   P6  direct-caller malformed result kinds never write a row, never close
 *       the permit, never count.
 *   P7  forged / mismatched settlement receipts (other owner, other permit,
 *       scored without policy lineage) are refused before any lock or write.
 *   P8  account switch: a shot id settled by account B is a permanent
 *       conflict for account A — never accepted for A, never a charge on A's
 *       permit; A's own next id settles normally.
 *   P9  the same shot id offered on BOTH channels (online permit + offline
 *       ticket) spends exactly one rating.
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import postgres from "postgres";
import type { JSONValue } from "postgres";
import { canonicalizeOfflineJson, digestCanonicalOfflineJson } from "../canonicalDigest.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

// Fresh ids per run: the disposable DB is shared with other suites.
const RUN = crypto.randomUUID().slice(0, 8);
const U = (n: number): string => `0000000c-ad02-4000-8000-${RUN}00${String(n).padStart(2, "0")}`;
const SESSION = (n: number): string =>
  `0000000c-ad02-4000-8000-${RUN}0a${String(n).padStart(2, "0")}`;
const KEY = (name: string): string => `${name}-${RUN}`;

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

let shotSeq = 0;
function shotId(): string {
  shotSeq += 1;
  return `0000000c-ad02-4000-8000-${RUN}5${String(shotSeq).padStart(3, "0")}`;
}

type Payload = Record<string, JSONValue>;

function shotPayload(
  id: string,
  analysisPermitId: string | null,
  overrides: Payload = {},
): Payload {
  const resultKind = typeof overrides.resultKind === "string" ? overrides.resultKind : "scored";
  return {
    id,
    analysisPermitId,
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-08T10:00:00.000Z",
    startMs: 0,
    contactMs: 100,
    endMs: 200,
    overallScore: resultKind === "scored" ? 7 : null,
    confidence: 0.9,
    resultKind,
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

/** The offline ticket payload shape consume_offline_ticket() expects. */
function ticketShot(id: string): Payload {
  const { analysisPermitId: _permit, ...rest } = shotPayload(id, null);
  return rest;
}

async function createUser(sql: Sql, n: number, provider = "google"): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${U(n)}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${U(n)}', 'adv2-${n}-${RUN}@example.com', '{"provider":"${provider}"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('${provider}', 'adv2-${n}-${RUN}', '${U(n)}', '{"sub":"adv2-${n}-${RUN}"}')`,
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

async function reserve(
  sql: Sql,
  n: number,
  key: string,
): Promise<{ result: string; permitId: string | null }> {
  const rows = await inTx(
    sql,
    n,
    async (tx) =>
      await tx.unsafe<{ result: string; permit_id: string | null }[]>(
        `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
      ),
  );
  return { result: rows[0].result, permitId: rows[0].permit_id };
}

async function reserved(sql: Sql, n: number, key: string): Promise<string> {
  const r = await reserve(sql, n, key);
  assertEquals(r.result, "accepted", `reserve ${key}`);
  assert(r.permitId);
  return r.permitId;
}

async function sync(sql: Sql, n: number, payload: Payload): Promise<string> {
  return await inTx(sql, n, async (tx) => {
    const rows = await tx.unsafe(`select public.apply_synced_shot($1::jsonb) as r`, [
      tx.json(payload),
    ]);
    return String(rows[0].r);
  });
}

async function permitState(sql: Sql, permitId: string): Promise<string> {
  const rows = await sql.unsafe(
    `select status || '/' || coalesce(outcome, 'NULL') as s from public.analysis_permits where id = '${permitId}'`,
  );
  return rows.length === 0 ? "MISSING" : String(rows[0].s);
}

async function permitCreatedAt(sql: Sql, permitId: string): Promise<string> {
  const rows = await sql.unsafe(
    `select created_at::text as c from public.analysis_permits where id = '${permitId}'`,
  );
  return String(rows[0].c);
}

async function shotRows(
  sql: Sql,
  n: number,
): Promise<Array<{ id: string; result_kind: string; permit: string | null }>> {
  const rows = await sql.unsafe<{ id: string; result_kind: string; permit: string | null }[]>(
    `select id::text as id, result_kind, analysis_permit_id::text as permit
     from public.shots where user_id = '${U(n)}' order by id`,
  );
  return rows.map((r) => ({ id: r.id, result_kind: r.result_kind, permit: r.permit }));
}

/** lifetime_scored_count() as the caller sees it (identity ledger aware). */
async function scoredCount(sql: Sql, n: number): Promise<number> {
  return await inTx(sql, n, async (tx) => {
    const rows = await tx.unsafe(`select public.lifetime_scored_count()::int as n`);
    return Number(rows[0].n);
  });
}

async function holdCount(sql: Sql, n: number): Promise<number> {
  return await inTx(sql, n, async (tx) => {
    const rows = await tx.unsafe(`select public.offline_hold_count()::int as n`);
    return Number(rows[0].n);
  });
}

/** A reservation that exists WITHOUT the reservation gate having counted the
 * hold (a row reserved before the grant was issued, or a pre-fix row). The
 * client role cannot mint one on this head (asserted in P1), so the owner
 * role stands in; it exists so the RPC's free-limit BACKSTOP is what decides. */
async function legacyReserved(sql: Sql, n: number, key: string): Promise<string> {
  const id = crypto.randomUUID();
  await sql.unsafe(
    `insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
     values ('${id}', '${U(n)}', '${key}', 'reserved', null)`,
  );
  return id;
}

function pgCode(e: unknown): string {
  return String((e as { code?: unknown }).code ?? "");
}

/** Backdate a reservation past the sweep horizon and run the pg_cron sweep
 * statement for exactly that row (owner role stands in for pg_cron). */
async function expire(sql: Sql, permitId: string): Promise<void> {
  await sql.unsafe(
    `with stale as (
       delete from public.analysis_permits where id = '${permitId}' and status = 'reserved'
       returning id, user_id, idempotency_key, status, outcome
     )
     insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome, created_at)
     select id, user_id, idempotency_key, status, outcome, now() - interval '25 hours' from stale`,
  );
  await sql.unsafe(
    `update public.analysis_permits set status = 'released', outcome = 'expired'
     where id = '${permitId}' and status = 'reserved' and created_at < now() - interval '24 hours'`,
  );
}

interface ReceiptOptions {
  ownerId?: string;
  shotId?: string;
  permitId?: string;
  resultKind?: string;
  policy?: { version: string; sha256: string } | null;
}

/** A settlement receipt in the exact shape the RPC verifies (the edge builds
 * the same object; here the adversary controls every field). */
async function receipt(shot: Payload, ownerId: string, options: ReceiptOptions = {}) {
  const binding = {
    ownerId: options.ownerId ?? ownerId,
    shotId: options.shotId ?? String(shot.id),
    analysisPermitId: options.permitId ?? String(shot.analysisPermitId),
    resultKind: options.resultKind ?? String(shot.resultKind),
    payloadSha256: await digestCanonicalOfflineJson(shot),
    installationKeyId: null,
    operationId: null,
    grant: null,
    ticket: null,
  };
  const policy = options.policy === undefined
    ? binding.resultKind === "scored" ? { version: "adv2-policy-1", sha256: "c".repeat(64) } : null
    : options.policy;
  const document = {
    schemaVersion: 1,
    kind: "settlement_receipt",
    binding,
    bindingSha256: await digestCanonicalOfflineJson(binding),
    policy,
  };
  const canonical = canonicalizeOfflineJson(document);
  return { canonical, sha256: await digestCanonicalOfflineJson(document) };
}

async function withSql(fn: (sql: Sql) => Promise<void>): Promise<void> {
  const sql = postgres(PG_URL, { max: 6, onnotice: () => {} });
  try {
    await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ── P1 ───────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "ADV2-P1 offline HOLD vs online consumption: one held ticket + one scored rating fill the free allowance; the backstop closes a second reserved permit as free_limit_exceeded and releasing the ticket does not reopen it",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      await createUser(sql, 1);
      const held = await inTx(sql, 1, async (tx) => {
        const reg = await tx.unsafe<{ result: string }[]>(
          `select r.result from public.register_offline_device('${
            KEY("p1")
          }', 'production', true) r`,
        );
        assertEquals(reg[0].result, "accepted");
        const grant = await tx.unsafe<{ result: string; ticket_ids: string[] | null }[]>(
          `select g.result, g.ticket_ids::text[] as ticket_ids from public.issue_offline_grant('${
            KEY("p1")
          }', 1) g`,
        );
        assertEquals(grant[0].result, "accepted", "grant");
        assertEquals(grant[0].ticket_ids?.length, 1);
        return grant[0].ticket_ids![0];
      });
      // Allocation is not consumption.
      assertEquals(await scoredCount(sql, 1), 0);
      assertEquals(await holdCount(sql, 1), 1);

      const online = await reserved(sql, 1, KEY("p1-a"));
      const first = shotId();
      assertEquals(await sync(sql, 1, shotPayload(first, online)), "accepted");
      assertEquals(await permitState(sql, online), "finalized/scored");
      assertEquals(await scoredCount(sql, 1), 1);

      // The reservation gate already says no (1 scored + 1 held = 2)...
      assertEquals((await reserve(sql, 1, KEY("p1-b"))).result, "access.paywall_required");
      // ...the client cannot mint a reservation around it...
      let minted = "";
      try {
        await inTx(sql, 1, async (tx) => {
          await tx.unsafe(
            `insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
             values ('${crypto.randomUUID()}', '${U(1)}', '${KEY("p1-mint")}', 'reserved', null)`,
          );
        });
      } catch (e) {
        minted = pgCode(e);
      }
      assertEquals(minted, "42501", "authenticated INSERT into analysis_permits must be denied");
      // ...and the RPC backstop closes a reservation that slipped past it.
      const legacy = await legacyReserved(sql, 1, KEY("p1-legacy"));
      const second = shotId();
      assertEquals(await sync(sql, 1, shotPayload(second, legacy)), "access.paywall_required");
      assertEquals(await permitState(sql, legacy), "released/free_limit_exceeded");
      assertEquals((await shotRows(sql, 1)).map((s) => s.id), [first]);

      // Return the ticket: per the conservation rule a returned ticket is not
      // a re-credit (offline_hold_count() still counts it), so nothing reopens
      // — neither the closed permit nor a fresh reservation — and the account
      // still holds exactly one counted rating.
      const released = await inTx(sql, 1, async (tx) => {
        const rows = await tx.unsafe(
          `select public.release_offline_ticket('${held}', 'unused_ticket_returned') as r`,
        );
        return String(rows[0].r);
      });
      assertEquals(released, "accepted");
      assertEquals(await holdCount(sql, 1), 1);
      assertEquals(await sync(sql, 1, shotPayload(second, legacy)), "access.permit_not_reserved");
      assertEquals(await permitState(sql, legacy), "released/free_limit_exceeded");
      assertEquals((await reserve(sql, 1, KEY("p1-c"))).result, "access.paywall_required");
      assertEquals(await scoredCount(sql, 1), 1);
      assertEquals((await shotRows(sql, 1)).map((s) => s.id), [first]);
    });
  },
});

// ── P2 ───────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "ADV2-P2 partial is terminal: released/partial refuses a later scored shot and a same-id replay flipped to scored; the stored row and the count are untouched",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      await createUser(sql, 2);
      const permit = await reserved(sql, 2, KEY("p2"));
      const id = shotId();
      assertEquals(
        await sync(sql, 2, shotPayload(id, permit, { resultKind: "partial" })),
        "accepted",
      );
      assertEquals(await permitState(sql, permit), "released/partial");
      assertEquals(await scoredCount(sql, 2), 0);

      // Upgrade attempts.
      assertEquals(await sync(sql, 2, shotPayload(shotId(), permit)), "access.permit_not_reserved");
      const flipped = await sync(
        sql,
        2,
        shotPayload(id, permit, { resultKind: "scored", overallScore: 9 }),
      );
      assert(
        flipped === "accepted" || flipped === "shot.receipt_mismatch",
        `replay verdict ${flipped}`,
      );
      assertEquals(await shotRows(sql, 2), [{ id, result_kind: "partial", permit }]);
      assertEquals(await permitState(sql, permit), "released/partial");
      assertEquals(await scoredCount(sql, 2), 0);

      // And the other direction: a consumed permit never takes a partial.
      const scoredPermit = await reserved(sql, 2, KEY("p2-b"));
      assertEquals(await sync(sql, 2, shotPayload(shotId(), scoredPermit)), "accepted");
      assertEquals(
        await sync(sql, 2, shotPayload(shotId(), scoredPermit, { resultKind: "partial" })),
        "access.permit_not_reserved",
      );
      assertEquals(await permitState(sql, scoredPermit), "finalized/scored");
      assertEquals(await scoredCount(sql, 2), 1);
    });
  },
});

// ── P3 ───────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "ADV2-P3 late sync onto EXPIRED reservations: scored → finalized/scored, partial → released/partial, low_confidence → released/low_confidence, each WITHOUT rewriting created_at; a consumed expired permit stays consumed",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      await createUser(sql, 3);
      const cases: Array<[string, string]> = [
        ["scored", "finalized/scored"],
        ["partial", "released/partial"],
        ["low_confidence", "released/low_confidence"],
      ];
      for (const [kind, expected] of cases) {
        const permit = await reserved(sql, 3, KEY(`p3-${kind}`));
        await expire(sql, permit);
        assertEquals(await permitState(sql, permit), "released/expired");
        const before = await permitCreatedAt(sql, permit);
        const id = shotId();
        assertEquals(
          await sync(sql, 3, shotPayload(id, permit, { resultKind: kind })),
          "accepted",
          kind,
        );
        assertEquals(await permitState(sql, permit), expected);
        assertEquals(await permitCreatedAt(sql, permit), before, "permit metadata untouched");
        // Second settlement on the same expired permit: refused, state kept.
        assertEquals(
          await sync(sql, 3, shotPayload(shotId(), permit, { resultKind: kind })),
          "access.permit_not_reserved",
        );
        assertEquals(await permitState(sql, permit), expected);
      }
      assertEquals(await scoredCount(sql, 3), 1);
      assertEquals((await shotRows(sql, 3)).length, 3);
    });
  },
});

// ── P4 ───────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "ADV2-P4 premium boundary: a premium row past expires_at is NOT premium (third rating paywalled, permit closed); a live premium row admits it",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      await createUser(sql, 4);
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
         values ('${U(4)}', true, 'pickle_sensei_pro_monthly', now() - interval '1 hour')`,
      );
      for (const k of ["a", "b"]) {
        const permit = await reserved(sql, 4, KEY(`p4-${k}`));
        assertEquals(await sync(sql, 4, shotPayload(shotId(), permit)), "accepted");
      }
      assertEquals(await scoredCount(sql, 4), 2);
      assertEquals((await reserve(sql, 4, KEY("p4-c"))).result, "access.paywall_required");
      const legacy = await legacyReserved(sql, 4, KEY("p4-legacy"));
      assertEquals(await sync(sql, 4, shotPayload(shotId(), legacy)), "access.paywall_required");
      assertEquals(await permitState(sql, legacy), "released/free_limit_exceeded");
      assertEquals(await scoredCount(sql, 4), 2);

      // Entitlement verified live (edge-owned write, service role stands in).
      await sql.unsafe(
        `update public.billing_entitlements set expires_at = now() + interval '30 days', verified_at = now()
         where user_id = '${U(4)}'`,
      );
      const pro = await reserved(sql, 4, KEY("p4-d"));
      assertEquals(await sync(sql, 4, shotPayload(shotId(), pro)), "accepted");
      assertEquals(await permitState(sql, pro), "finalized/scored");
      // Premium never reopens the permit the free backstop closed.
      assertEquals(await sync(sql, 4, shotPayload(shotId(), legacy)), "access.permit_not_reserved");
      assertEquals(await permitState(sql, legacy), "released/free_limit_exceeded");
    });
  },
});

// ── P5 ───────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "ADV2-P5 session boundary is HOLD: a shot naming another account's session (or a missing one) is shot.session_not_found, no row, permit still reserved; the corrected retry settles",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      await createUser(sql, 5);
      await createUser(sql, 6);
      const foreignSession = crypto.randomUUID();
      await sql.unsafe(
        `insert into public.sessions (id, user_id, started_at) values ('${foreignSession}', '${
          U(6)
        }', now())`,
      );
      const permit = await reserved(sql, 5, KEY("p5"));
      const id = shotId();
      assertEquals(
        await sync(sql, 5, shotPayload(id, permit, { sessionId: foreignSession })),
        "shot.session_not_found",
      );
      assertEquals(
        await sync(sql, 5, shotPayload(id, permit, { sessionId: crypto.randomUUID() })),
        "shot.session_not_found",
      );
      assertEquals(await permitState(sql, permit), "reserved/NULL");
      assertEquals((await shotRows(sql, 5)).length, 0);
      assertEquals(await scoredCount(sql, 5), 0);

      const own = crypto.randomUUID();
      await inTx(sql, 5, async (tx) => {
        await tx.unsafe(
          `insert into public.sessions (id, user_id, started_at) values ('${own}', '${
            U(5)
          }', now())`,
        );
      });
      assertEquals(await sync(sql, 5, shotPayload(id, permit, { sessionId: own })), "accepted");
      assertEquals(await permitState(sql, permit), "finalized/scored");
      assertEquals(await scoredCount(sql, 5), 1);
      assertEquals((await shotRows(sql, 6)).length, 0, "nothing leaked onto the session owner");
    });
  },
});

// ── P6 ───────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "ADV2-P6 direct caller with malformed result kinds (SCORED / abstained / '' / null / number) — typed write_failed:<SQLSTATE>, no row, permit still reserved, nothing counted",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      await createUser(sql, 7);
      const permit = await reserved(sql, 7, KEY("p6"));
      for (const resultKind of ["SCORED", "abstained", "", null, 1, "low_confidence "]) {
        const verdict = await sync(
          sql,
          7,
          shotPayload(shotId(), permit, { resultKind, overallScore: null }),
        );
        assert(
          /^shot\.write_failed:[0-9A-Z]{5}$/.test(verdict),
          `${JSON.stringify(resultKind)} → ${verdict}`,
        );
        assertEquals(
          await permitState(sql, permit),
          "reserved/NULL",
          `after ${JSON.stringify(resultKind)}`,
        );
      }
      // Scores that contradict the label (edge parser invariant, table CHECK).
      const contradictions: Payload[] = [
        { resultKind: "low_confidence", overallScore: 6 },
        { resultKind: "scored", overallScore: null },
        { resultKind: "scored", overallScore: 11 },
        { resultKind: "scored", overallScore: "seven" },
      ];
      for (const overrides of contradictions) {
        const verdict = await sync(sql, 7, shotPayload(shotId(), permit, overrides));
        assert(
          /^shot\.write_failed:[0-9A-Z]{5}$/.test(verdict),
          `${JSON.stringify(overrides)} → ${verdict}`,
        );
        assertEquals(await permitState(sql, permit), "reserved/NULL");
      }
      assertEquals((await shotRows(sql, 7)).length, 0);
      assertEquals(await scoredCount(sql, 7), 0);
      // The permit still backs the honest retry.
      assertEquals(await sync(sql, 7, shotPayload(shotId(), permit)), "accepted");
    });
  },
});

// ── P7 ───────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "ADV2-P7 forged receipts: another owner's id, another permit, a flipped result kind, a scored receipt without policy lineage, a digest that does not match — every one is shot.receipt_invalid before any write; the matching receipt settles once and a replay under a different receipt is a mismatch",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      await createUser(sql, 8);
      await createUser(sql, 9);
      const permit = await reserved(sql, 8, KEY("p7"));
      const other = await reserved(sql, 8, KEY("p7-other"));
      const payload = shotPayload(shotId(), permit);
      const forgeries: Array<[string, ReceiptOptions]> = [
        ["other owner", { ownerId: U(9) }],
        ["other permit", { permitId: other }],
        ["flipped kind", { resultKind: "partial" }],
        ["scored without policy", { policy: null }],
        ["other shot id", { shotId: shotId() }],
      ];
      for (const [label, options] of forgeries) {
        const r = await receipt(payload, U(8), options);
        assertEquals(
          await sync(sql, 8, { ...payload, settlementReceipt: r }),
          "shot.receipt_invalid",
          label,
        );
      }
      const good = await receipt(payload, U(8));
      assertEquals(
        await sync(sql, 8, { ...payload, settlementReceipt: { ...good, sha256: "0".repeat(64) } }),
        "shot.receipt_invalid",
        "digest mismatch",
      );
      assertEquals(
        await sync(sql, 8, {
          ...payload,
          settlementReceipt: { canonical: good.canonical, sha256: null },
        }),
        "shot.receipt_invalid",
        "null digest",
      );
      assertEquals(
        await sync(sql, 8, { ...payload, settlementReceipt: { sha256: good.sha256 } }),
        "shot.receipt_invalid",
        "missing canonical",
      );
      assertEquals(await permitState(sql, permit), "reserved/NULL");
      assertEquals(await permitState(sql, other), "reserved/NULL");
      assertEquals((await shotRows(sql, 8)).length, 0);

      assertEquals(await sync(sql, 8, { ...payload, settlementReceipt: good }), "accepted");
      assertEquals(await permitState(sql, permit), "finalized/scored");
      const stored = await sql.unsafe<{ n: number }[]>(
        `select count(*)::int as n from public.settlement_receipts where shot_id = '${payload.id}' and user_id = '${
          U(8)
        }'`,
      );
      assertEquals(Number(stored[0].n), 1);

      // Replays: identical → accepted; a different policy lineage → mismatch;
      // no receipt at all (a caller that lost it) → mismatch, never a re-charge.
      assertEquals(await sync(sql, 8, { ...payload, settlementReceipt: good }), "accepted");
      const otherPolicy = await receipt(payload, U(8), {
        policy: { version: "adv2-policy-2", sha256: "d".repeat(64) },
      });
      assertEquals(
        await sync(sql, 8, { ...payload, settlementReceipt: otherPolicy }),
        "shot.receipt_mismatch",
      );
      assertEquals(await sync(sql, 8, payload), "shot.receipt_mismatch");
      assertEquals(await scoredCount(sql, 8), 1);
      assertEquals(
        await permitState(sql, other),
        "reserved/NULL",
        "the other permit was never touched",
      );
    });
  },
});

// ── P7b ──────────────────────────────────────────────────────────────────────
// The receipt validator compares `jsonb_typeof(v_transport -> 'sha256')` to
// 'string'; for an ABSENT key jsonb_typeof() is NULL, every comparison in the
// OR-chain is NULL, and the `if` is skipped — the digest is never checked.

Deno.test({
  name:
    "ADV2-P7b a settlement receipt transport with NO sha256 key must be shot.receipt_invalid (digest unverifiable) — nothing written",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      await createUser(sql, 14);
      const permit = await reserved(sql, 14, KEY("p7b"));
      const payload = shotPayload(shotId(), permit);
      const good = await receipt(payload, U(14));
      const verdict = await sync(sql, 14, {
        ...payload,
        settlementReceipt: { canonical: good.canonical },
      });
      const state = await permitState(sql, permit);
      const rows = await shotRows(sql, 14);
      assertEquals(
        verdict,
        "shot.receipt_invalid",
        `receipt without a digest was ${verdict}; permit ${state}; rows ${rows.length}`,
      );
      assertEquals(state, "reserved/NULL");
      assertEquals(rows.length, 0);
    });
  },
});

// ── P8 ───────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "ADV2-P8 account switch: a shot id already settled by account B is shot.id_conflict for account A (with or without a receipt), A's permit stays reserved and unspent, A's next id settles; B's row is byte-identical",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      await createUser(sql, 10);
      await createUser(sql, 11);
      const bPermit = await reserved(sql, 11, KEY("p8-b"));
      const shared = shotId();
      assertEquals(await sync(sql, 11, shotPayload(shared, bPermit)), "accepted");
      const bRowBefore = await sql.unsafe(`select * from public.shots where id = '${shared}'`);

      const aPermit = await reserved(sql, 10, KEY("p8-a"));
      const aPayload = shotPayload(shared, aPermit, { overallScore: 3 });
      assertEquals(await sync(sql, 10, aPayload), "shot.id_conflict");
      const aReceipt = await receipt(aPayload, U(10));
      assertEquals(
        await sync(sql, 10, { ...aPayload, settlementReceipt: aReceipt }),
        "shot.id_conflict",
      );
      assertEquals(await permitState(sql, aPermit), "reserved/NULL");
      assertEquals(await scoredCount(sql, 10), 0);
      assertEquals((await shotRows(sql, 10)).length, 0);

      const bRowAfter = await sql.unsafe(`select * from public.shots where id = '${shared}'`);
      assertEquals(bRowAfter, bRowBefore, "B's settlement is untouched by A's attempts");
      assertEquals(String(bRowAfter[0].user_id), U(11));

      const own = shotId();
      assertEquals(await sync(sql, 10, shotPayload(own, aPermit)), "accepted");
      assertEquals(await permitState(sql, aPermit), "finalized/scored");
      assertEquals(await scoredCount(sql, 10), 1);
      assertEquals(await scoredCount(sql, 11), 1);
    });
  },
});

// ── P9 ───────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "ADV2-P9 one shot id on both channels: settled online then offered to consume_offline_ticket → offline.shot_not_chargeable with the ticket still held; settled offline then offered online with a permit → no second row, the permit is not consumed, exactly one rating counted each way",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      // Online first, offline second.
      await createUser(sql, 12);
      const ticket12 = await inTx(sql, 12, async (tx) => {
        await tx.unsafe(
          `select public.register_offline_device('${KEY("p9a")}', 'production', true)`,
        );
        const grant = await tx.unsafe<{ result: string; ticket_ids: string[] | null }[]>(
          `select g.result, g.ticket_ids::text[] as ticket_ids from public.issue_offline_grant('${
            KEY("p9a")
          }', 1) g`,
        );
        assertEquals(grant[0].result, "accepted");
        return grant[0].ticket_ids![0];
      });
      const permit12 = await reserved(sql, 12, KEY("p9a-permit"));
      const id12 = shotId();
      assertEquals(await sync(sql, 12, shotPayload(id12, permit12)), "accepted");
      const offline12 = await inTx(sql, 12, async (tx) => {
        const rows = await tx.unsafe(
          `select public.consume_offline_ticket('${ticket12}', $1::jsonb) as r`,
          [tx.json(ticketShot(id12))],
        );
        return String(rows[0].r);
      });
      assertEquals(offline12, "offline.shot_not_chargeable");
      assertEquals(
        await holdCount(sql, 12),
        1,
        "the ticket is still held (allocation != consumption)",
      );
      assertEquals(await scoredCount(sql, 12), 1);
      assertEquals((await shotRows(sql, 12)).length, 1);

      // Offline first, online second.
      await createUser(sql, 13);
      const ticket13 = await inTx(sql, 13, async (tx) => {
        await tx.unsafe(
          `select public.register_offline_device('${KEY("p9b")}', 'production', true)`,
        );
        const grant = await tx.unsafe<{ result: string; ticket_ids: string[] | null }[]>(
          `select g.result, g.ticket_ids::text[] as ticket_ids from public.issue_offline_grant('${
            KEY("p9b")
          }', 1) g`,
        );
        assertEquals(grant[0].result, "accepted");
        return grant[0].ticket_ids![0];
      });
      const id13 = shotId();
      const consumed = await inTx(sql, 13, async (tx) => {
        const rows = await tx.unsafe(
          `select public.consume_offline_ticket('${ticket13}', $1::jsonb) as r`,
          [tx.json(ticketShot(id13))],
        );
        return String(rows[0].r);
      });
      assertEquals(consumed, "accepted");
      assertEquals(await scoredCount(sql, 13), 1);
      // The reservation gate is already full (1 scored + 0 held = 1 < 2 → a
      // second reservation is still legal); the SAME id must not spend it.
      const permit13 = await reserved(sql, 13, KEY("p9b-permit"));
      const online13 = await sync(sql, 13, shotPayload(id13, permit13));
      assert(
        online13 === "accepted" || online13 === "shot.receipt_mismatch",
        `replay verdict ${online13}`,
      );
      assertEquals(
        await permitState(sql, permit13),
        "reserved/NULL",
        "the permit is not consumed by a replay",
      );
      assertEquals((await shotRows(sql, 13)).length, 1);
      assertEquals(await scoredCount(sql, 13), 1);
      assertNotEquals((await shotRows(sql, 13))[0].permit, permit13);
    });
  },
});
