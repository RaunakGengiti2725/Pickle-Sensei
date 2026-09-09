// W04-04 ADVERSARIAL ATTACKS — live postgres half.
//
// Every test here drives the REAL public.settle_offline_receipt() on a
// disposable postgres:16 with every migration applied (./xc_pg_up.sh,
// XC_PG_URL) and tries to break the at-most-once / HOLD-not-refund contract
// at a failure boundary the candidate's own suite does not pin:
//
//   A1 concurrency     — the same receipt from two connections at once; two
//                        different receipts racing for one ticket.
//   A2 conservation    — lifetime_scored_count() / offline_hold_count() /
//                        free_rating_ledger move by exactly one for one
//                        settled receipt, and not at all for replays, holds,
//                        contradictory evidence or a rolled-back attempt.
//   A3 roles           — anon, service_role, a bearer without the API proof,
//                        a bearer without a live session, another user
//                        delivering the owner's receipt verbatim, another user
//                        naming the owner's ticket under their own name; the
//                        settlement table for every client role.
//   A4 boundaries      — lifecycleSequence / generation at the edge of the safe
//                        integer range, zero, negative, fractional, string;
//                        an upper-case digest; malformed output values that
//                        fail inside the shot writer (int overflow, bad
//                        timestamp, check violation).
//   A5 corrupt state   — a settlement row whose digest was altered; a
//                        settlement row deleted while the ledger says consumed;
//                        an abstention receipt for a ticket already consumed;
//                        an abstention receipt for a ticket already released.
//   A6 process death   — the settlement transaction rolled back after the RPC
//                        answered (crash before commit); the retry under the
//                        same operation settles once; a retry under a NEW
//                        operation id never charges a second time.
//   A7 identities      — receipt / operation ids are namespaced per user (no
//                        cross-account interference); the same operation id
//                        reused for a second ticket is HELD with that ticket
//                        still reserved.
//   A8 pending         — a receipt naming a session that belongs to ANOTHER
//                        user is never settled and never consumes.
//
// Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
// On BASE_SHA the RPC does not exist, so every test fails there.

import postgres from "postgres";
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { exportJWK, generateKeyPair } from "jose";
import {
  OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION,
  OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
  OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
  type OfflineExecutionGrantClaims,
  type OfflineFreeTicketReference,
  type OfflineReleasedArtifacts,
  type OfflineResultReceipt,
  type OfflineSignedExecutionGrant,
} from "../../../../packages/shared-types/src/offlineAuthorization.ts";
import { digestCanonicalOfflineJson, digestOfflineGrantTransport } from "../canonicalDigest.ts";
import {
  importOfflineGrantVerificationKey,
  offlineGrantClaimsFromIssuance,
  type OfflineGrantKey,
  signOfflineExecutionGrant,
} from "../offlineSignature.ts";
import { activeReleasePolicyRow, HARNESS_RELEASE_POLICY } from "./releasePolicyFixture.ts";
import { SUPABASE_URL } from "./routesHarness.ts";

const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const KID = "w04-04-attack-key";

const keyPair = await generateKeyPair("ES256", { extractable: true });
const signingKey: OfflineGrantKey = {
  purpose: "offline_execution_grant",
  kid: KID,
  key: keyPair.privateKey,
};
await importOfflineGrantVerificationKey(KID, await exportJWK(keyPair.publicKey));

const releasePolicyRow = await activeReleasePolicyRow();
const approval = releasePolicyRow.approval as { policy: { version: string; sha256: string } };
const RELEASE: OfflineReleasedArtifacts = {
  policy: approval.policy,
  mechanicsModel: HARNESS_RELEASE_POLICY.mechanics.lineage.model,
  benchmarkModel: HARNESS_RELEASE_POLICY.benchmark.lineage.model,
};

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

async function sign(claims: OfflineExecutionGrantClaims): Promise<OfflineSignedExecutionGrant> {
  return await signOfflineExecutionGrant(claims, signingKey, {
    binding: {
      issuer: ISSUER,
      allowedKeyIds: [KID],
      ownerId: claims.sub,
      installationKeyId: claims.installationKeyId,
    },
    release: RELEASE,
    nowEpochSeconds: claims.iat + 1,
  });
}

function output(
  resultId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: resultId,
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
    phases: [{ key: "prep", startMs: 0, representativeMs: 50, endMs: 100, confidence: 0.8 }],
    checkpoints: [
      {
        key: "paddle_height",
        score: 70,
        confidence: 0.8,
        band: "green",
        direction: "up",
        severity: 0.1,
        applicable: true,
      },
    ],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

const ABSTAIN = { resultKind: "low_confidence", overallScore: null };

interface ReceiptOptions {
  receiptId: string;
  ownerId: string;
  grant: OfflineSignedExecutionGrant;
  claims: OfflineExecutionGrantClaims;
  ticket: OfflineFreeTicketReference | null;
  lifecycleSequence: number;
  operationId: string;
  resultId: string;
  fullOutputSha256: string;
  billingDisposition?: OfflineResultReceipt["billingDisposition"];
  installationKeyId?: string;
}

async function receipt(options: ReceiptOptions): Promise<OfflineResultReceipt> {
  return {
    schemaVersion: OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
    receiptId: options.receiptId,
    ownerId: options.ownerId,
    installationKeyId: options.installationKeyId ?? options.claims.installationKeyId,
    grantId: options.claims.jti,
    grantJwsSha256: await digestOfflineGrantTransport(options.grant),
    ticket: options.ticket,
    lifecycleSequence: options.lifecycleSequence,
    nativeTime: {
      schemaVersion: OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
      clock: "ios_mach_continuous_time",
      anchorId: "anchor-w04-04-attack",
      elapsedMs: 120_000,
    },
    attestation: {
      schemaVersion: OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION,
      format: "apple_app_attest",
      kind: "assertion",
      environment: "production",
      dataBase64Url: "QUJDRA",
      clientDataSha256: "c".repeat(64),
    },
    operationId: options.operationId,
    resultId: options.resultId,
    fullOutputSha256: options.fullOutputSha256,
    billingDisposition: options.billingDisposition ?? "joint_verification_required",
  };
}

function ticketRef(
  ticketId: string,
  claims: OfflineExecutionGrantClaims,
): OfflineFreeTicketReference {
  assert(claims.allocation, "free grant expected");
  return {
    allocationId: claims.allocation.allocationId,
    generation: claims.allocation.generation,
    ticketId,
  };
}

// ---------------------------------------------------------------------------
// Live postgres plumbing (same conventions as the candidate suite, distinct
// user id space so both can run in one database).
// ---------------------------------------------------------------------------

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

interface SettleRow {
  result: string;
  delivery: string | null;
  status: string | null;
  reason_code: string | null;
  financial_disposition: string | null;
  result_id: string | null;
}

const RUN = crypto.randomUUID().slice(0, 8);
const U = (n: number): string => `0000000c-0404-4000-8000-${RUN}00${String(n).padStart(2, "0")}`;
const SESSION = (n: number): string =>
  `0000000c-0404-4000-8000-${RUN}0a${String(n).padStart(2, "0")}`;
const KEY = (name: string): string => `atk-${name}-${RUN}`;
const IDENTITY = (n: number): string => `w04-04-atk-${n}-${RUN}`;

async function createUser(sql: Sql, n: number): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${U(n)}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${U(n)}', 'w04-04-atk-${n}-${RUN}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', '${IDENTITY(n)}', '${U(n)}', '{"sub":"${IDENTITY(n)}"}')`,
  );
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${SESSION(n)}', '${U(n)}')`);
}

async function asUser(
  tx: Tx,
  n: number,
  options: { session?: boolean; apiKey?: boolean } = {},
): Promise<void> {
  if (options.apiKey ?? true) {
    await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
      'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  }
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${U(n)}'`);
  if (options.session ?? true) {
    await tx.unsafe(`set local request.jwt.claims = '{"session_id":"${SESSION(n)}"}'`);
  }
}

function inTx<T>(sql: Sql, n: number | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    if (n !== null) await asUser(tx as unknown as Tx, n);
    return await fn(tx as unknown as Tx);
  }) as Promise<T>;
}

const lit = (value: unknown): string => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

function settleSql(
  rec: unknown,
  sha256: string,
  out: Record<string, unknown> | null,
  hold: string | null,
): string {
  return `select r.result, r.delivery, r.status, r.reason_code, r.financial_disposition, r.result_id
     from public.settle_offline_receipt(
       ${lit(rec)},
       '${sha256}',
       ${out === null ? "null::jsonb" : lit(out)},
       ${hold === null ? "null::text" : `'${hold}'`}
     ) r`;
}

async function settleRaw(
  tx: Tx,
  rec: unknown,
  sha256: string,
  out: Record<string, unknown> | null,
  hold: string | null,
): Promise<SettleRow> {
  const rows = await tx.unsafe<SettleRow[]>(settleSql(rec, sha256, out, hold));
  assertEquals(rows.length, 1);
  return rows[0];
}

async function settle(
  tx: Tx,
  rec: OfflineResultReceipt,
  out: Record<string, unknown> | null,
  hold: string | null = null,
): Promise<SettleRow> {
  return await settleRaw(tx, rec, await digestCanonicalOfflineJson(rec), out, hold);
}

async function ledgerEvents(sql: Sql, ticketId: string): Promise<string[]> {
  const rows = await sql.unsafe<{ event: string }[]>(
    `select event from public.offline_allocation_ledger where ticket_id = '${ticketId}' order by id`,
  );
  return rows.map((row) => row.event);
}

async function shotCount(sql: Sql, ticketId: string): Promise<number> {
  const [{ count }] = await sql.unsafe<{ count: string }[]>(
    `select count(*)::text as count from public.shots where offline_ticket_id = '${ticketId}'`,
  );
  return Number(count);
}

async function userShotCount(sql: Sql, n: number): Promise<number> {
  const [{ count }] = await sql.unsafe<{ count: string }[]>(
    `select count(*)::text as count from public.shots where user_id = '${U(n)}'`,
  );
  return Number(count);
}

interface SettlementRow {
  user_id: string;
  receipt_id: string;
  status: string;
  reason_code: string | null;
  financial_disposition: string;
  result_id: string | null;
  receipt_sha256: string;
}

async function settlements(sql: Sql, n: number): Promise<SettlementRow[]> {
  return await sql.unsafe<SettlementRow[]>(
    `select user_id, receipt_id, status, reason_code, financial_disposition, result_id, receipt_sha256
     from public.offline_receipt_settlements where user_id = '${U(n)}' order by id`,
  );
}

async function counters(sql: Sql, n: number): Promise<{ held: number; scored: number }> {
  const [{ held, scored }] = await inTx(
    sql,
    n,
    (tx) =>
      tx.unsafe<{ held: number; scored: number }[]>(
        `select public.offline_hold_count() as held, public.lifetime_scored_count() as scored`,
      ),
  );
  return { held: Number(held), scored: Number(scored) };
}

async function ledgerScored(sql: Sql, n: number): Promise<number | null> {
  const rows = await sql.unsafe<{ scored_count: number }[]>(
    `select scored_count from public.free_rating_ledger
     where identity_hash = encode(sha256(convert_to('google:${IDENTITY(n)}', 'UTF8')), 'hex')`,
  );
  return rows.length === 0 ? null : Number(rows[0].scored_count);
}

type LiveGrant = { claims: OfflineExecutionGrantClaims; grant: OfflineSignedExecutionGrant };

async function issueFreeGrant(sql: Sql, n: number, key: string, requested = 2): Promise<LiveGrant> {
  await inTx(sql, n, async (tx) => {
    const rows = await tx.unsafe<{ result: string }[]>(
      `select r.result from public.register_offline_device('${key}', 'production', true) r`,
    );
    assertEquals(rows[0].result, "accepted");
  });
  const row = await inTx(sql, n, async (tx) => {
    const rows = await tx.unsafe<{ row: unknown }[]>(
      `select to_jsonb(g) as row from public.issue_offline_grant('${key}', ${requested}) g`,
    );
    return rows[0].row;
  });
  const claims = offlineGrantClaimsFromIssuance(row, {
    issuer: ISSUER,
    ownerId: U(n),
    installationKeyId: key,
    release: RELEASE,
  });
  assert(
    claims.allocation && claims.allocation.ticketIds.length === requested,
    `free grant expected: ${JSON.stringify(row)}`,
  );
  return { claims, grant: await sign(claims) };
}

async function liveReceipt(
  ownerId: string,
  issued: LiveGrant,
  ticketId: string | null,
  tag: string,
  overrides: Partial<ReceiptOptions> = {},
  outputOverrides: Record<string, unknown> = {},
): Promise<{ receipt: OfflineResultReceipt; output: Record<string, unknown> }> {
  const resultId = crypto.randomUUID();
  const out = output(resultId, outputOverrides);
  const rec = await receipt({
    receiptId: `receipt-${tag}-${RUN}`,
    ownerId,
    grant: issued.grant,
    claims: issued.claims,
    ticket: ticketId === null ? null : ticketRef(ticketId, issued.claims),
    lifecycleSequence: 1,
    operationId: `operation-${tag}-${RUN}`,
    resultId,
    fullOutputSha256: await digestCanonicalOfflineJson(out),
    ...overrides,
  });
  return { receipt: rec, output: out };
}

const SETTLED_CONSUMED = (resultId: string): SettleRow => ({
  result: "accepted",
  delivery: "settled",
  status: "result_recorded",
  reason_code: null,
  financial_disposition: "consumed",
  result_id: resultId,
});

const HELD = (reason: string, disposition: string): SettleRow => ({
  result: "accepted",
  delivery: "held",
  status: "reconciliation_required",
  reason_code: reason,
  financial_disposition: disposition,
  result_id: null,
});

const REJECTED = (code: string): SettleRow => ({
  result: code,
  delivery: null,
  status: null,
  reason_code: null,
  financial_disposition: null,
  result_id: null,
});

// ---------------------------------------------------------------------------
// A1 — concurrency
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "ATTACK A1 concurrency: the same receipt delivered from two connections at the same instant settles exactly once (one settled, one replayed; one consumed event, one shot)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    try {
      await createUser(sql, 1);
      const issued = await issueFreeGrant(sql, 1, KEY("a1"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const a = await liveReceipt(U(1), issued, ticketA, "a1");

      const verdicts = await Promise.all([
        inTx(sql, 1, (tx) => settle(tx, a.receipt, a.output)),
        inTx(sql, 1, (tx) => settle(tx, a.receipt, a.output)),
        inTx(sql, 1, (tx) => settle(tx, a.receipt, a.output)),
      ]);
      const deliveries = verdicts.map((v) => v.delivery).sort();
      assertEquals(deliveries, ["replayed", "replayed", "settled"]);
      for (const v of verdicts) {
        assertEquals(v.status, "result_recorded");
        assertEquals(v.financial_disposition, "consumed");
        assertEquals(v.result_id, a.receipt.resultId);
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);
      assertEquals((await settlements(sql, 1)).length, 1);
      assertEquals(await counters(sql, 1), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATTACK A1 concurrency: two DIFFERENT receipts racing for one ticket end with exactly one consumed event; the loser is a conflicting_receipt HOLD, never a second charge",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    try {
      await createUser(sql, 2);
      const issued = await issueFreeGrant(sql, 2, KEY("a1b"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const x = await liveReceipt(U(2), issued, ticketA, "a1b-x");
      const y = await liveReceipt(U(2), issued, ticketA, "a1b-y", { lifecycleSequence: 2 });

      const [vx, vy] = await Promise.all([
        inTx(sql, 2, (tx) => settle(tx, x.receipt, x.output)),
        inTx(sql, 2, (tx) => settle(tx, y.receipt, y.output)),
      ]);
      const settled = [vx, vy].filter((v) => v.delivery === "settled");
      const held = [vx, vy].filter((v) => v.delivery === "held");
      assertEquals(settled.length, 1, JSON.stringify([vx, vy]));
      assertEquals(held.length, 1, JSON.stringify([vx, vy]));
      assertEquals(settled[0].financial_disposition, "consumed");
      assertEquals(held[0], HELD("conflicting_receipt", "reserved"));
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);
      assertEquals(await userShotCount(sql, 2), 1);
      assertEquals(await counters(sql, 2), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// A2 — free-rating conservation
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "ATTACK A2 conservation: scored + held budget stays 2 across settle, replays, evidence_missing, contradictory evidence and a foreign hold; the identity ledger moves by exactly one",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 3);
      await createUser(sql, 4);
      const issued = await issueFreeGrant(sql, 3, KEY("a2"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;
      assertEquals(await counters(sql, 3), { held: 2, scored: 0 });
      assertEquals(await ledgerScored(sql, 3), null);

      // One settled receipt: exactly one rating leaves the budget.
      const a = await liveReceipt(U(3), issued, ticketA, "a2-a");
      assertEquals(
        await inTx(sql, 3, (tx) => settle(tx, a.receipt, a.output)),
        SETTLED_CONSUMED(a.receipt.resultId),
      );
      assertEquals(await counters(sql, 3), { held: 1, scored: 1 });
      assertEquals(await ledgerScored(sql, 3), 1);

      // Replays: nothing moves.
      for (let i = 0; i < 3; i += 1) {
        assertEquals(
          (await inTx(sql, 3, (tx) => settle(tx, a.receipt, a.output))).delivery,
          "replayed",
        );
      }
      assertEquals(await counters(sql, 3), { held: 1, scored: 1 });
      assertEquals(await ledgerScored(sql, 3), 1);

      // Chargeable receipt for B with the output missing: HELD, B reserved.
      const missing = await liveReceipt(U(3), issued, ticketB, "a2-missing", {
        lifecycleSequence: 2,
      });
      assertEquals(
        await inTx(sql, 3, (tx) => settle(tx, missing.receipt, null)),
        HELD("evidence_missing", "reserved"),
      );
      // Chargeable receipt for B whose output abstains: HELD, B reserved.
      const abstainOut = output(crypto.randomUUID(), ABSTAIN);
      const mismatch = await liveReceipt(U(3), issued, ticketB, "a2-mismatch", {
        lifecycleSequence: 3,
        resultId: String(abstainOut.id),
        fullOutputSha256: await digestCanonicalOfflineJson(abstainOut),
      });
      assertEquals(
        await inTx(sql, 3, (tx) => settle(tx, mismatch.receipt, abstainOut)),
        HELD("evidence_ambiguous", "reserved"),
      );
      // not_chargeable receipt for B beside a scored output: HELD, B reserved.
      const contradictory = await liveReceipt(U(3), issued, ticketB, "a2-contra", {
        lifecycleSequence: 4,
        billingDisposition: "not_chargeable",
      });
      assertEquals(
        await inTx(sql, 3, (tx) => settle(tx, contradictory.receipt, contradictory.output)),
        HELD("evidence_ambiguous", "reserved"),
      );
      // Another account delivering the owner's receipt for B: HELD in the
      // caller's namespace; the owner's budget and ledger untouched.
      const ownerB = await liveReceipt(U(3), issued, ticketB, "a2-ownerb", {
        lifecycleSequence: 5,
      });
      assertEquals(
        await inTx(sql, 4, (tx) => settle(tx, ownerB.receipt, ownerB.output)),
        HELD("owner_mismatch", "reserved"),
      );

      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(await shotCount(sql, ticketB), 0);
      assertEquals(await userShotCount(sql, 3), 1);
      assertEquals(await userShotCount(sql, 4), 0);
      assertEquals(await counters(sql, 3), { held: 1, scored: 1 });
      assertEquals(await counters(sql, 4), { held: 0, scored: 0 });
      assertEquals(await ledgerScored(sql, 3), 1);
      assertEquals(await ledgerScored(sql, 4), null);

      // The owner can still settle B legitimately: budget fully spent, never overspent.
      const b = await liveReceipt(U(3), issued, ticketB, "a2-b", { lifecycleSequence: 6 });
      assertEquals(
        await inTx(sql, 3, (tx) => settle(tx, b.receipt, b.output)),
        SETTLED_CONSUMED(b.receipt.resultId),
      );
      assertEquals(await counters(sql, 3), { held: 0, scored: 2 });
      assertEquals(await ledgerScored(sql, 3), 2);
      assertEquals(await userShotCount(sql, 3), 2);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// A3 — unauthorised roles
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "ATTACK A3 roles: anon, service_role, a bearer without the API proof and a bearer without a live session are all refused by settle_offline_receipt() and nothing is written",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 5);
      const issued = await issueFreeGrant(sql, 5, KEY("a3"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const a = await liveReceipt(U(5), issued, ticketA, "a3");
      const sha = await digestCanonicalOfflineJson(a.receipt);
      const call = settleSql(a.receipt, sha, a.output, null);

      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await tx.unsafe(`set local role anon`);
            await tx.unsafe(call);
          }),
        Error,
        "permission denied",
      );
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await tx.unsafe(`set local role service_role`);
            await tx.unsafe(call);
          }),
        Error,
        "permission denied",
      );
      // authenticated, live session, but no x-pickle-api-key: refused.
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, 5, { apiKey: false });
            await tx.unsafe(call);
          }),
        Error,
        "authorization required",
      );
      // authenticated with the API proof but no session claim: refused.
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, 5, { session: false });
            await tx.unsafe(call);
          }),
        Error,
        "authorization required",
      );
      // authenticated with a session id that belongs to ANOTHER user: refused.
      await createUser(sql, 6);
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, 5, { session: false });
            await tx.unsafe(`set local request.jwt.claims = '{"session_id":"${SESSION(6)}"}'`);
            await tx.unsafe(call);
          }),
        Error,
        "authorization required",
      );

      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotCount(sql, ticketA), 0);
      assertEquals((await settlements(sql, 5)).length, 0);

      // The allowed path still works for the owner with a live session.
      assertEquals(
        await inTx(sql, 5, (tx) => settle(tx, a.receipt, a.output)),
        SETTLED_CONSUMED(a.receipt.resultId),
      );

      // The settlement table is reachable by no client role at all.
      for (const role of ["anon", "authenticated", "service_role"]) {
        await assertRejects(
          () =>
            sql.begin(async (tx) => {
              await tx.unsafe(`set local role ${role}`);
              await tx.unsafe(`set local request.jwt.claim.sub = '${U(5)}'`);
              await tx.unsafe(`select count(*) from public.offline_receipt_settlements`);
            }),
          Error,
          "permission denied",
        );
        await assertRejects(
          () =>
            sql.begin(async (tx) => {
              await tx.unsafe(`set local role ${role}`);
              await tx.unsafe(`set local request.jwt.claim.sub = '${U(5)}'`);
              await tx.unsafe(
                `update public.offline_receipt_settlements set status = 'result_recorded' where user_id = '${
                  U(5)
                }'`,
              );
            }),
          Error,
          "permission denied",
        );
        await assertRejects(
          () =>
            sql.begin(async (tx) => {
              await tx.unsafe(`set local role ${role}`);
              await tx.unsafe(`set local request.jwt.claim.sub = '${U(5)}'`);
              await tx.unsafe(
                `delete from public.offline_receipt_settlements where user_id = '${U(5)}'`,
              );
            }),
          Error,
          "permission denied",
        );
      }
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATTACK A3 roles: another account naming the owner's ticket under ITS OWN name is HELD without consumption, and cannot block the true owner from settling that ticket once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 7);
      await createUser(sql, 8);
      const owner = await issueFreeGrant(sql, 7, KEY("a3-owner"));
      assert(owner.claims.allocation);
      const [ticketA] = owner.claims.allocation.ticketIds;

      // The attacker (user 8) forges a receipt in ITS OWN name over the owner's
      // grant + ticket lineage (the edge would already HOLD this on signature;
      // the RPC must independently refuse to consume the owner's ticket).
      const forged = await liveReceipt(U(8), owner, ticketA, "a3-forged");
      const verdict = await inTx(sql, 8, (tx) => settle(tx, forged.receipt, forged.output));
      assertEquals(verdict.delivery, "held", JSON.stringify(verdict));
      assertEquals(verdict.status, "reconciliation_required");
      assertNotEquals(verdict.financial_disposition, "consumed");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotCount(sql, ticketA), 0);
      assertEquals(await userShotCount(sql, 8), 0);
      assertEquals(await counters(sql, 8), { held: 0, scored: 0 });

      // The attacker also replays the owner's operation/result ids in its own
      // namespace: still no consumption, and it must not poison the owner.
      const legit = await liveReceipt(U(7), owner, ticketA, "a3-legit");
      const mirrored = { ...legit.receipt, ownerId: U(8), receiptId: `receipt-a3-mirror-${RUN}` };
      const mirror = await inTx(sql, 8, (tx) => settle(tx, mirrored, legit.output));
      assertEquals(mirror.delivery, "held", JSON.stringify(mirror));
      assertNotEquals(mirror.financial_disposition, "consumed");
      assertEquals(await shotCount(sql, ticketA), 0);

      // The true owner settles exactly once, after both foreign attempts.
      assertEquals(
        await inTx(sql, 7, (tx) => settle(tx, legit.receipt, legit.output)),
        SETTLED_CONSUMED(legit.receipt.resultId),
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);
      const [shot] = await sql.unsafe<{ user_id: string }[]>(
        `select user_id from public.shots where id = '${legit.receipt.resultId}'`,
      );
      assertEquals(shot.user_id, U(7));
      assertEquals(await counters(sql, 7), { held: 1, scored: 1 });
      assertEquals(await counters(sql, 8), { held: 0, scored: 0 });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// A4 — boundary values
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "ATTACK A4 boundaries: lifecycleSequence at MAX_SAFE_INTEGER settles; 2^53, 0, -1, 1.5, '1' and an upper-case digest are rejected with nothing durable; a wrong generation is a HOLD with the ticket reserved",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 9);
      const issued = await issueFreeGrant(sql, 9, KEY("a4"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;

      const probes: Array<[string, unknown]> = [
        ["2^53", 9007199254740992],
        ["zero", 0],
        ["negative", -1],
        ["fraction", 1.5],
        ["string", "1"],
        ["huge", 1e300],
      ];
      for (const [tag, sequence] of probes) {
        const base = await liveReceipt(U(9), issued, ticketA, `a4-${tag}`);
        const rec = { ...base.receipt, lifecycleSequence: sequence };
        const verdict = await inTx(
          sql,
          9,
          (tx) => settleRaw(tx, rec, "a".repeat(64), base.output, null),
        );
        assertEquals(verdict, REJECTED("offline.invalid_input"), `lifecycleSequence ${tag}`);
      }
      for (const [tag, generation] of probes) {
        const base = await liveReceipt(U(9), issued, ticketA, `a4-gen-${tag}`);
        assert(base.receipt.ticket);
        const rec = { ...base.receipt, ticket: { ...base.receipt.ticket, generation } };
        const verdict = await inTx(
          sql,
          9,
          (tx) => settleRaw(tx, rec, "b".repeat(64), base.output, null),
        );
        assertEquals(verdict, REJECTED("offline.invalid_input"), `generation ${tag}`);
      }
      // Upper-case hex is not the digest alphabet the table accepts.
      const upper = await liveReceipt(U(9), issued, ticketA, "a4-upper");
      const upperSha = (await digestCanonicalOfflineJson(upper.receipt)).toUpperCase();
      assertEquals(
        await inTx(sql, 9, (tx) => settleRaw(tx, upper.receipt, upperSha, upper.output, null)),
        REJECTED("offline.invalid_input"),
      );
      assertEquals((await settlements(sql, 9)).length, 0);
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);

      // A generation the grant never claimed: coherent shape, incoherent lineage → HOLD.
      const wrongGen = await liveReceipt(U(9), issued, ticketB, "a4-wronggen");
      assert(wrongGen.receipt.ticket);
      const wrongGenRec = {
        ...wrongGen.receipt,
        ticket: { ...wrongGen.receipt.ticket, generation: wrongGen.receipt.ticket.generation + 1 },
      };
      assertEquals(
        await inTx(sql, 9, (tx) => settle(tx, wrongGenRec, wrongGen.output)),
        HELD("evidence_ambiguous", "reserved"),
      );
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);

      // The far edge of the safe range is a legitimate value: it settles.
      const max = await liveReceipt(U(9), issued, ticketA, "a4-max", {
        lifecycleSequence: 9007199254740991,
      });
      assertEquals(
        await inTx(sql, 9, (tx) => settle(tx, max.receipt, max.output)),
        SETTLED_CONSUMED(max.receipt.resultId),
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await counters(sql, 9), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATTACK A4 boundaries: outputs the shot writer cannot store (int4 overflow, unparsable timestamp, out-of-range score, far-future capture) never crash the settlement: each is a durable HOLD or a recorded result, the ticket is never consumed twice",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 10);
      const issued = await issueFreeGrant(sql, 10, KEY("a4b"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;

      const poison: Array<[string, Record<string, unknown>]> = [
        ["int-overflow", { startMs: 2147483648, contactMs: 2147483649, endMs: 2147483650 }],
        ["bad-timestamp", { capturedAt: "not-a-timestamp" }],
        ["score-out-of-range", { overallScore: 10_000 }],
        ["phase-int-overflow", {
          phases: [{
            key: "prep",
            startMs: 0,
            representativeMs: 50,
            endMs: 2147483648,
            confidence: 0.8,
          }],
        }],
      ];
      let seq = 1;
      for (const [tag, overrides] of poison) {
        const p = await liveReceipt(
          U(10),
          issued,
          ticketA,
          `a4b-${tag}`,
          { lifecycleSequence: seq },
          overrides,
        );
        seq += 1;
        const verdict = await inTx(sql, 10, (tx) => settle(tx, p.receipt, p.output));
        assertEquals(verdict.result, "accepted", `${tag}: ${JSON.stringify(verdict)}`);
        assertEquals(verdict.delivery, "held", `${tag}: ${JSON.stringify(verdict)}`);
        assertEquals(verdict.financial_disposition, "reserved");
        // Redelivery replays the same durable verdict.
        const again = await inTx(sql, 10, (tx) => settle(tx, p.receipt, p.output));
        assertEquals(again, { ...verdict, delivery: "replayed" });
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotCount(sql, ticketA), 0);

      // A far-future capture clock is not the settlement's business: it settles
      // once, then replays, and the ledger says exactly one consumed event.
      const future = await liveReceipt(
        U(10),
        issued,
        ticketB,
        "a4b-future",
        { lifecycleSequence: seq },
        { capturedAt: "2999-12-31T23:59:59.000Z" },
      );
      const verdict = await inTx(sql, 10, (tx) => settle(tx, future.receipt, future.output));
      assertEquals(verdict.result, "accepted");
      assert(
        verdict.delivery === "settled" || verdict.delivery === "held",
        JSON.stringify(verdict),
      );
      const again = await inTx(sql, 10, (tx) => settle(tx, future.receipt, future.output));
      assertEquals(again, { ...verdict, delivery: "replayed" });
      const events = await ledgerEvents(sql, ticketB);
      assert(
        events.filter((e) => e === "consumed").length <= 1,
        `ticket B consumed more than once: ${events}`,
      );
      assertEquals(
        events.includes("consumed"),
        verdict.financial_disposition === "consumed",
        JSON.stringify({ events, verdict }),
      );
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// A5 — corrupt / partially persisted state
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "ATTACK A5 corrupt state: a settlement row whose digest was altered makes the honest redelivery a receipt_conflict (never a fabricated replay, never a second consumption)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 11);
      const issued = await issueFreeGrant(sql, 11, KEY("a5"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const a = await liveReceipt(U(11), issued, ticketA, "a5");
      assertEquals(
        await inTx(sql, 11, (tx) => settle(tx, a.receipt, a.output)),
        SETTLED_CONSUMED(a.receipt.resultId),
      );
      // The table is append-only for every role including the owner; bit rot
      // is simulated the only way it can be — with the guard triggers bypassed.
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local session_replication_role = replica`);
        await tx.unsafe(
          `update public.offline_receipt_settlements set receipt_sha256 = repeat('0', 64)
           where user_id = '${U(11)}' and receipt_id = '${a.receipt.receiptId}'`,
        );
      });
      const verdict = await inTx(sql, 11, (tx) => settle(tx, a.receipt, a.output));
      assertEquals(verdict, REJECTED("offline.receipt_conflict"));
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);
      assertEquals((await settlements(sql, 11)).length, 1);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATTACK A5 corrupt state: the settlement row lost while the ledger says consumed — redelivery re-records the SAME result without a second consumed event, shot or ledger increment",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 12);
      const issued = await issueFreeGrant(sql, 12, KEY("a5b"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const a = await liveReceipt(U(12), issued, ticketA, "a5b");
      assertEquals(
        await inTx(sql, 12, (tx) => settle(tx, a.receipt, a.output)),
        SETTLED_CONSUMED(a.receipt.resultId),
      );
      assertEquals(await counters(sql, 12), { held: 1, scored: 1 });
      // Partial persistence (ledger + shot committed, settlement row gone) can
      // only be manufactured with the append-only guard bypassed.
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local session_replication_role = replica`);
        await tx.unsafe(
          `delete from public.offline_receipt_settlements
           where user_id = '${U(12)}' and receipt_id = '${a.receipt.receiptId}'`,
        );
      });
      const verdict = await inTx(sql, 12, (tx) => settle(tx, a.receipt, a.output));
      assertEquals(verdict.result, "accepted", JSON.stringify(verdict));
      assertEquals(verdict.status, "result_recorded", JSON.stringify(verdict));
      assertEquals(verdict.financial_disposition, "consumed");
      assertEquals(verdict.result_id, a.receipt.resultId);
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);
      assertEquals(await counters(sql, 12), { held: 1, scored: 1 });
      assertEquals(await ledgerScored(sql, 12), 1);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATTACK A5 corrupt state: a not_chargeable abstention receipt for a ticket the ledger already CONSUMED must be a HOLD (conflicting_receipt) — the ledger tells another story about this ticket",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 13);
      const issued = await issueFreeGrant(sql, 13, KEY("a5c"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const a = await liveReceipt(U(13), issued, ticketA, "a5c-scored");
      assertEquals(
        await inTx(sql, 13, (tx) => settle(tx, a.receipt, a.output)),
        SETTLED_CONSUMED(a.receipt.resultId),
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);

      // A SECOND receipt, new operation + result, says "I abstained under
      // ticket A, nothing to charge" — but ticket A already paid for a rating.
      const abstainOut = output(crypto.randomUUID(), ABSTAIN);
      const abstain = await liveReceipt(U(13), issued, ticketA, "a5c-abstain", {
        lifecycleSequence: 2,
        billingDisposition: "not_chargeable",
        resultId: String(abstainOut.id),
        fullOutputSha256: await digestCanonicalOfflineJson(abstainOut),
      });
      const verdict = await inTx(sql, 13, (tx) => settle(tx, abstain.receipt, abstainOut));
      assertEquals(
        verdict,
        HELD("conflicting_receipt", "reserved"),
        `abstention on a consumed ticket was recorded, not held: ${JSON.stringify(verdict)}`,
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await counters(sql, 13), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATTACK A5 corrupt state: a not_chargeable abstention receipt for a ticket the ledger already RELEASED must be a HOLD, not a result_recorded settlement that reports the ticket 'reserved'",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 14);
      const issued = await issueFreeGrant(sql, 14, KEY("a5d"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const released = await inTx(sql, 14, (tx) =>
        tx.unsafe<{ result: string }[]>(
          `select public.release_offline_ticket('${ticketA}', 'unused_ticket_returned') as result`,
        ));
      assertEquals(released[0].result, "accepted");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "released"]);

      const abstainOut = output(crypto.randomUUID(), ABSTAIN);
      const abstain = await liveReceipt(U(14), issued, ticketA, "a5d-abstain", {
        billingDisposition: "not_chargeable",
        resultId: String(abstainOut.id),
        fullOutputSha256: await digestCanonicalOfflineJson(abstainOut),
      });
      const verdict = await inTx(sql, 14, (tx) => settle(tx, abstain.receipt, abstainOut));
      assertEquals(verdict.result, "accepted");
      assertEquals(
        verdict.status,
        "reconciliation_required",
        `abstention on a released ticket was ${verdict.status} / ${verdict.financial_disposition}: ${
          JSON.stringify(verdict)
        }`,
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "released"]);
      // A chargeable receipt for the released ticket is likewise held, never consumed.
      const scored = await liveReceipt(U(14), issued, ticketA, "a5d-scored", {
        lifecycleSequence: 2,
      });
      const chargeable = await inTx(sql, 14, (tx) => settle(tx, scored.receipt, scored.output));
      assertEquals(chargeable, HELD("conflicting_receipt", "reserved"));
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "released"]);
      assertEquals(await shotCount(sql, ticketA), 0);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// A6 — process death / restart
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "ATTACK A6 process death: a settlement whose transaction dies after the RPC answered leaves nothing durable; the retry under the SAME operation settles once; a retry under a NEW operation id never charges again",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 15);
      const issued = await issueFreeGrant(sql, 15, KEY("a6"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const a = await liveReceipt(U(15), issued, ticketA, "a6");

      class Crash extends Error {}
      await assertRejects(
        () =>
          inTx(sql, 15, async (tx) => {
            const verdict = await settle(tx, a.receipt, a.output);
            assertEquals(verdict, SETTLED_CONSUMED(a.receipt.resultId));
            throw new Crash("isolate died before commit");
          }),
        Crash,
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotCount(sql, ticketA), 0);
      assertEquals((await settlements(sql, 15)).length, 0);
      assertEquals(await counters(sql, 15), { held: 2, scored: 0 });
      assertEquals(await ledgerScored(sql, 15), null);

      // Restart: the outbox redelivers the very same receipt — it is a first
      // settlement now (nothing durable survived), consumed exactly once.
      assertEquals(
        await inTx(sql, 15, (tx) => settle(tx, a.receipt, a.output)),
        SETTLED_CONSUMED(a.receipt.resultId),
      );
      assertEquals(
        (await inTx(sql, 15, (tx) => settle(tx, a.receipt, a.output))).delivery,
        "replayed",
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);
      assertEquals(await counters(sql, 15), { held: 1, scored: 1 });

      // The forbidden client behaviour — retrying the same work under a NEW
      // operation id with a new result — must never be a second charge.
      const retry = await liveReceipt(U(15), issued, ticketA, "a6-newop", {
        lifecycleSequence: 2,
      });
      assertEquals(
        await inTx(sql, 15, (tx) => settle(tx, retry.receipt, retry.output)),
        HELD("conflicting_receipt", "reserved"),
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);
      assertEquals(await userShotCount(sql, 15), 1);
      assertEquals(await counters(sql, 15), { held: 1, scored: 1 });
      assertEquals(await ledgerScored(sql, 15), 1);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// A7 — replay / duplicate identities
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "ATTACK A7 identities: receipt and operation ids are namespaced per account (no cross-account conflict or leak); the same operation id reused for a second ticket of the same account is HELD with that ticket reserved",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 16);
      await createUser(sql, 17);
      const g16 = await issueFreeGrant(sql, 16, KEY("a7-16"));
      const g17 = await issueFreeGrant(sql, 17, KEY("a7-17"));
      assert(g16.claims.allocation && g17.claims.allocation);
      const [t16a, t16b] = g16.claims.allocation.ticketIds;
      const [t17a] = g17.claims.allocation.ticketIds;

      // Both accounts pick the SAME receipt id and operation id.
      const r16 = await liveReceipt(U(16), g16, t16a, "a7-shared");
      const r17 = await liveReceipt(U(17), g17, t17a, "a7-shared");
      assertEquals(r16.receipt.receiptId, r17.receipt.receiptId);
      assertEquals(r16.receipt.operationId, r17.receipt.operationId);
      assertEquals(
        await inTx(sql, 16, (tx) => settle(tx, r16.receipt, r16.output)),
        SETTLED_CONSUMED(r16.receipt.resultId),
      );
      assertEquals(
        await inTx(sql, 17, (tx) => settle(tx, r17.receipt, r17.output)),
        SETTLED_CONSUMED(r17.receipt.resultId),
      );
      // Each account's replay is its OWN verdict, never the other's.
      const replay17 = await inTx(sql, 17, (tx) => settle(tx, r17.receipt, r17.output));
      assertEquals(replay17, { ...SETTLED_CONSUMED(r17.receipt.resultId), delivery: "replayed" });
      assertEquals(await ledgerEvents(sql, t16a), ["allocated", "consumed"]);
      assertEquals(await ledgerEvents(sql, t17a), ["allocated", "consumed"]);

      // Same account, second ticket, the FIRST ticket's operation id: HELD.
      const reuse = await liveReceipt(U(16), g16, t16b, "a7-reuse", {
        operationId: r16.receipt.operationId,
        lifecycleSequence: 2,
      });
      assertEquals(
        await inTx(sql, 16, (tx) => settle(tx, reuse.receipt, reuse.output)),
        HELD("conflicting_receipt", "reserved"),
      );
      // Same account, second ticket, the FIRST ticket's result id: HELD.
      const reuseResult = await liveReceipt(U(16), g16, t16b, "a7-reuse-result", {
        resultId: r16.receipt.resultId,
        lifecycleSequence: 3,
      });
      const verdict = await inTx(sql, 16, (tx) => settle(tx, reuseResult.receipt, r16.output));
      assertEquals(verdict.delivery, "held", JSON.stringify(verdict));
      assertEquals(verdict.financial_disposition, "reserved");
      assertEquals(await ledgerEvents(sql, t16b), ["allocated"]);
      assertEquals(await shotCount(sql, t16b), 0);
      assertEquals(await counters(sql, 16), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// A8 — pending path with a session that can never sync for this caller
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "ATTACK A8 pending: a receipt naming ANOTHER account's session is never settled, never consumes and never records a fabricated result — redelivery keeps answering without a charge",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 18);
      await createUser(sql, 19);
      const issued = await issueFreeGrant(sql, 18, KEY("a8"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const foreignSession = crypto.randomUUID();
      await sql.unsafe(
        `insert into public.sessions (id, user_id, started_at) values ('${foreignSession}', '${
          U(19)
        }', now())`,
      );
      const a = await liveReceipt(U(18), issued, ticketA, "a8", {}, { sessionId: foreignSession });
      for (let i = 0; i < 2; i += 1) {
        const verdict = await inTx(sql, 18, (tx) => settle(tx, a.receipt, a.output));
        assertEquals(verdict.result, "accepted", JSON.stringify(verdict));
        assertNotEquals(verdict.status, "result_recorded", JSON.stringify(verdict));
        assertNotEquals(verdict.financial_disposition, "consumed");
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotCount(sql, ticketA), 0);
      const [{ count }] = await sql.unsafe<{ count: string }[]>(
        `select count(*)::text as count from public.shots where session_id = '${foreignSession}'`,
      );
      assertEquals(count, "0");
      assertEquals(await counters(sql, 18), { held: 2, scored: 0 });
    } finally {
      await sql.end();
    }
  },
});
