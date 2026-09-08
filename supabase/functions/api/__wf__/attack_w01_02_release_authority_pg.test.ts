/**
 * W01-02 ADVERSARIAL TESTS (live PostgreSQL) — attack branch
 * devin/pp/w01-02/attack-c01576c4 against candidate c01576c4.
 *
 * The harness attacks stub the authority RPC. These run the candidate's REAL
 * verifier (`readChargeableReleaseAdmission` from ../releasePolicy.ts) against
 * rows produced by the REAL `public.read_analysis_release_policy()` on a
 * disposable postgres:16 with shim_auth.sql + every migration applied
 * (./xc_pg_up.sh), driving the owner-only install/approve/activate/withdraw/
 * deny functions exactly as an operator would. Nothing about the authority is
 * mocked.
 *
 *   ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json attack_w01_02_release_authority_pg.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 *
 *   PG-1 production default (nothing installed) → ineligible/unverified
 *   PG-2 install → approve mechanics → approve benchmark → activate: the row
 *        the SQL emits (numeric epochs, jsonb key order, null withdrawnAt)
 *        verifies under the shared canonicaliser/digest → ACTIVE
 *   PG-3 half-approved policy cannot be activated (SQL) and a hand-activated
 *        one is still refused by the edge verifier (unreleased)
 *   PG-4 withdraw → withdrawn on the very next read (no caching); a fresh
 *        policy re-activates; deny_new → withdrawn while approval stands
 *   PG-5 the same row evaluated with a clock past validUntil → expired; with
 *        a clock before validFrom → unreleased (edge clock vs DB clock)
 *   PG-6 role matrix on the new SQL surface: anon/authenticated cannot read
 *        or mutate the authority; service_role can read but not mutate
 *   PG-7 free-rating conservation: the edge's exact `partial` payload settles
 *        a reserved permit released/partial through apply_synced_shot() as
 *        `authenticated`, lifetime_scored_count() is unchanged, the permit
 *        cannot back a later scored shot, and a partial carrying a score is
 *        refused by the SQL layer as well
 *   PG-8 a scored shot naming a swept (released/expired) permit still
 *        settles in SQL — the release gate must therefore live in the edge
 *        (documents why the candidate's gate is the only gate)
 */
import postgres from "postgres";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { canonicalizeOfflineJson, digestCanonicalOfflineJson } from "../canonicalDigest.ts";
import { readChargeableReleaseAdmission } from "../releasePolicy.ts";
import type { AnalysisReleasePolicyDocument } from "../../../../packages/shared-types/src/analysisReleasePolicy.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const U1 = "0000000b-0102-4000-8000-000000000001";
const U2 = "0000000b-0102-4000-8000-000000000002";
const RUN = `${Date.now().toString(36)}`;

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

const artifact = { version: "fixture-1", sha256: "c".repeat(64) };
const lineage = {
  pipeline: artifact,
  definition: artifact,
  model: artifact,
  preprocessing: artifact,
  calibration: artifact,
  dataset: artifact,
  validationReport: artifact,
  supportedDomain: artifact,
};
const REPORT_SHA = artifact.sha256;

const now = () => Math.floor(Date.now() / 1000);

function policyDocument(
  version: string,
  overrides: Partial<AnalysisReleasePolicyDocument> = {},
): AnalysisReleasePolicyDocument {
  const t = now();
  return {
    schemaVersion: "analysis-release-policy-v1",
    version,
    validFrom: t - 3_600,
    validUntil: t + 3_600,
    mechanics: { lineage },
    benchmark: {
      lineage,
      uncertainty: {
        kind: "calibrated_prediction_interval",
        nominalCoverage: 0.9,
        coverageScope: "supported_slice",
        calibrationUnit: "player_session",
      },
      maximumIntervalWidth: 1.5,
      boundaryStep: 0.25,
      supportedIntervals: [{ lower: 3, upper: 5 }],
    },
    supportedInputs: [
      { shotType: "dink", cameraView: "side", handedness: "right", captureMode: "imported_video" },
    ],
    ...overrides,
  };
}

async function install(sql: Sql, doc: AnalysisReleasePolicyDocument): Promise<string> {
  const canonical = canonicalizeOfflineJson(doc);
  const sha = await digestCanonicalOfflineJson(doc);
  await sql.unsafe(`select public.install_analysis_release_policy($1, $2)`, [canonical, sha]);
  return sha;
}

async function approve(sql: Sql, sha: string, output: "mechanics" | "benchmark"): Promise<void> {
  await sql.unsafe(`select public.approve_analysis_release_output($1, $2, 'attack-approver', $3)`, [
    sha,
    output,
    REPORT_SHA,
  ]);
}

async function activate(sql: Sql, sha: string): Promise<void> {
  await sql.unsafe(`select public.activate_analysis_release_policy($1, 'attack-operator')`, [sha]);
}

/** The edge function's reader, but through the real SQL as service_role. */
function serviceRoleReader(sql: Sql) {
  return async () => {
    try {
      const rows = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role service_role`);
        return await tx.unsafe(`select public.read_analysis_release_policy() as row`);
      });
      return { data: (rows as Array<{ row: unknown }>)[0].row, error: null };
    } catch (error) {
      return { data: null, error };
    }
  };
}

async function resetControl(sql: Sql): Promise<void> {
  await sql.unsafe(
    `update api_private.analysis_release_control set active_policy_sha256 = null, deny_new_authorizations = true where singleton`,
  );
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function resetUsers(sql: Sql): Promise<void> {
  for (const id of [U1, U2]) {
    await sql.unsafe(`delete from auth.users where id = '${id}'`);
    await sql.unsafe(
      `insert into auth.users (id, email, raw_app_meta_data) values ('${id}', '${id}@example.com', '{"provider":"google"}')`,
    );
  }
}

function inTx<T>(sql: Sql, userId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    if (userId) await asUser(tx as unknown as Tx, userId);
    return await fn(tx as unknown as Tx);
  }) as Promise<T>;
}

async function reserve(sql: Sql, userId: string, key: string): Promise<string> {
  const rows = await inTx(sql, userId, async (tx) =>
    await tx.unsafe(
      `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
    ));
  assertEquals(rows[0].result, "accepted", `reserve ${key}`);
  return rows[0].permit_id as string;
}

/** Exactly the object syncShots() passes as `shot` to apply_synced_shot. */
function edgeShot(
  id: string,
  analysisPermitId: string,
  resultKind: "scored" | "low_confidence" | "partial",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    analysisPermitId,
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    startMs: 0,
    contactMs: 500,
    endMs: 1000,
    overallScore: resultKind === "scored" ? 7.5 : null,
    confidence: resultKind === "low_confidence" ? 0.2 : 0.9,
    resultKind,
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

async function apply(tx: Tx, payload: Record<string, unknown>): Promise<string> {
  const rows = await tx.unsafe(`select public.apply_synced_shot($1::jsonb) as r`, [payload]);
  return String(rows[0].r);
}

async function permitState(sql: Sql, permitId: string): Promise<string> {
  const rows = await sql.unsafe(
    `select status || '/' || coalesce(outcome, 'NULL') as s from public.analysis_permits where id = '${permitId}'`,
  );
  return rows.length === 0 ? "MISSING" : String(rows[0].s);
}

async function lifetimeScored(sql: Sql, userId: string): Promise<number> {
  const rows = await inTx(
    sql,
    userId,
    async (tx) => await tx.unsafe(`select public.lifetime_scored_count()::int as n`),
  );
  return Number(rows[0].n);
}

let shotSeq = 0;
function shotId(): string {
  shotSeq += 1;
  return `0000000b-0102-4000-8000-1${String(shotSeq).padStart(11, "0")}`;
}

async function withSql<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

Deno.test({
  name: "PG-1 production default (nothing installed) → ineligible/unverified, not unavailable",
  ignore,
}, async () => {
  await withSql(async (sql) => {
    await resetControl(sql);
    const read = serviceRoleReader(sql);
    const raw = await read();
    assertEquals(raw.error, null);
    assertEquals(raw.data, {
      document: null,
      canonicalDocument: null,
      approval: null,
      denyNewAuthorizations: true,
    });
    assertEquals(await readChargeableReleaseAdmission(read, now()), {
      status: "ineligible",
      reasonCode: "unverified",
    });
  });
});

Deno.test({
  name: "PG-2 install → approve ×2 → activate: the real SQL row verifies → ACTIVE",
  ignore,
}, async () => {
  await withSql(async (sql) => {
    await resetControl(sql);
    const doc = policyDocument(`attack-${RUN}-active`);
    const sha = await install(sql, doc);
    await approve(sql, sha, "mechanics");
    await approve(sql, sha, "benchmark");
    await activate(sql, sha);
    const read = serviceRoleReader(sql);
    const raw = (await read()).data as Record<string, unknown>;
    // Shape the SQL emits: integer epochs, null withdrawnAt, jsonb key order.
    const approval = raw.approval as Record<string, unknown>;
    assertEquals(typeof approval.mechanicsApprovedAt, "number");
    assertEquals(Number.isInteger(approval.mechanicsApprovedAt), true);
    assertEquals(approval.withdrawnAt, null);
    assertEquals(raw.denyNewAuthorizations, false);
    assertEquals(canonicalizeOfflineJson(raw.document), raw.canonicalDocument);
    const admission = await readChargeableReleaseAdmission(read, now());
    assertEquals(admission.status, "active", JSON.stringify(admission));
  });
});

Deno.test({
  name:
    "PG-3 half-approved policy: SQL refuses activation; a forced activation is still refused by the edge (unreleased)",
  ignore,
}, async () => {
  await withSql(async (sql) => {
    await resetControl(sql);
    const doc = policyDocument(`attack-${RUN}-half`);
    const sha = await install(sql, doc);
    await approve(sql, sha, "mechanics");
    await assertRejects(() => activate(sql, sha));
    // Owner-level tampering with the control row (no trigger guards it).
    await sql.unsafe(
      `update api_private.analysis_release_control set active_policy_sha256 = $1, deny_new_authorizations = false where singleton`,
      [sha],
    );
    const admission = await readChargeableReleaseAdmission(serviceRoleReader(sql), now());
    assertEquals(admission, { status: "ineligible", reasonCode: "unreleased" });
    await resetControl(sql);
  });
});

Deno.test({
  name:
    "PG-4 withdraw takes effect on the next read; a fresh policy re-activates; deny_new withdraws it again",
  ignore,
}, async () => {
  await withSql(async (sql) => {
    await resetControl(sql);
    const read = serviceRoleReader(sql);
    const first = await install(sql, policyDocument(`attack-${RUN}-w1`));
    await approve(sql, first, "mechanics");
    await approve(sql, first, "benchmark");
    await activate(sql, first);
    assertEquals((await readChargeableReleaseAdmission(read, now())).status, "active");

    await sql.unsafe(`select public.withdraw_analysis_release_policy($1, 'attack-operator')`, [
      first,
    ]);
    assertEquals(await readChargeableReleaseAdmission(read, now()), {
      status: "ineligible",
      reasonCode: "withdrawn",
    });
    // A withdrawn policy can never be re-activated.
    await assertRejects(() => activate(sql, first));

    const second = await install(sql, policyDocument(`attack-${RUN}-w2`));
    await approve(sql, second, "mechanics");
    await approve(sql, second, "benchmark");
    await activate(sql, second);
    assertEquals((await readChargeableReleaseAdmission(read, now())).status, "active");

    await sql.unsafe(`select public.deny_new_analysis_authorizations('attack-operator')`);
    assertEquals(await readChargeableReleaseAdmission(read, now()), {
      status: "ineligible",
      reasonCode: "withdrawn",
    });
    // Re-activating the still-approved policy lifts the switch.
    await activate(sql, second);
    assertEquals((await readChargeableReleaseAdmission(read, now())).status, "active");
    await resetControl(sql);
  });
});

Deno.test({
  name: "PG-5 the same active row under a skewed edge clock → expired / unreleased, never active",
  ignore,
}, async () => {
  await withSql(async (sql) => {
    await resetControl(sql);
    const t = now();
    const doc = policyDocument(`attack-${RUN}-clock`, { validFrom: t - 60, validUntil: t + 120 });
    const sha = await install(sql, doc);
    await approve(sql, sha, "mechanics");
    await approve(sql, sha, "benchmark");
    await activate(sql, sha);
    const read = serviceRoleReader(sql);
    assertEquals((await readChargeableReleaseAdmission(read, t)).status, "active");
    assertEquals(await readChargeableReleaseAdmission(read, t + 120), {
      status: "ineligible",
      reasonCode: "expired",
    });
    // Edge clock behind the DB approval stamp / before validFrom.
    assertEquals(await readChargeableReleaseAdmission(read, t - 61), {
      status: "ineligible",
      reasonCode: "unreleased",
    });
    await resetControl(sql);
  });
});

Deno.test({
  name:
    "PG-6 role matrix: anon/authenticated cannot read or mutate; service_role reads but cannot mutate",
  ignore,
}, async () => {
  await withSql(async (sql) => {
    await resetUsers(sql);
    const sha = "d".repeat(64);
    const mutations = [
      `select public.install_analysis_release_policy('{}', '${sha}')`,
      `select public.approve_analysis_release_output('${sha}', 'mechanics', 'x', '${sha}')`,
      `select public.activate_analysis_release_policy('${sha}', 'x')`,
      `select public.withdraw_analysis_release_policy('${sha}', 'x')`,
      `select public.deny_new_analysis_authorizations('x')`,
      `select * from api_private.analysis_release_control`,
      `update api_private.analysis_release_control set deny_new_authorizations = false`,
    ];
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const statement of [`select public.read_analysis_release_policy()`, ...mutations]) {
        const allowed = role === "service_role" &&
          statement.includes("read_analysis_release_policy");
        const attempt = sql.begin(async (tx) => {
          if (role === "authenticated") await asUser(tx as unknown as Tx, U1);
          else await tx.unsafe(`set local role ${role}`);
          await tx.unsafe(statement);
        });
        if (allowed) {
          await attempt;
        } else {
          const error = await assertRejects(() => attempt);
          assertEquals((error as { code?: string }).code, "42501", `${role}: ${statement}`);
        }
      }
    }
  });
});

Deno.test({
  name:
    "PG-7 free-rating conservation: the edge's partial payload settles released/partial, counts nothing, and cannot be upgraded",
  ignore,
}, async () => {
  await withSql(async (sql) => {
    await resetUsers(sql);
    const before = await lifetimeScored(sql, U1);
    assertEquals(before, 0);
    const permit = await reserve(sql, U1, `attack-${RUN}-partial`);
    const partialId = shotId();
    const result = await inTx(sql, U1, (tx) => apply(tx, edgeShot(partialId, permit, "partial")));
    assertEquals(result, "accepted");
    assertEquals(await permitState(sql, permit), "released/partial");
    assertEquals(await lifetimeScored(sql, U1), 0, "a partial must not count as a free rating");
    const rows = await sql.unsafe(
      `select result_kind, overall_score from public.shots where id = '${partialId}'`,
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].result_kind, "partial");
    assertEquals(rows[0].overall_score, null);

    // The settled permit cannot back a scored shot afterwards.
    const upgrade = await inTx(sql, U1, (tx) => apply(tx, edgeShot(shotId(), permit, "scored")));
    assertEquals(upgrade, "access.permit_not_reserved");
    assertEquals(await lifetimeScored(sql, U1), 0);

    // A partial carrying a score is refused at the SQL layer too.
    const permit2 = await reserve(sql, U1, `attack-${RUN}-partial-scored`);
    const scoredPartial = await inTx(
      sql,
      U1,
      (tx) => apply(tx, edgeShot(shotId(), permit2, "partial", { overallScore: 6 })),
    );
    assert(scoredPartial !== "accepted", `observed ${scoredPartial}`);
    assertEquals(await permitState(sql, permit2), "reserved/NULL");
    assertEquals(await lifetimeScored(sql, U1), 0);

    // Cross-user: U2 cannot settle a partial against U1's live permit.
    const stolen = await inTx(sql, U2, (tx) => apply(tx, edgeShot(shotId(), permit2, "partial")));
    assert(stolen !== "accepted", `observed ${stolen}`);
    assertEquals(await permitState(sql, permit2), "reserved/NULL");
  });
});

Deno.test({
  name:
    "PG-8 SQL settles a scored shot with NO policy installed — the edge gate is the only release gate",
  ignore,
}, async () => {
  await withSql(async (sql) => {
    await resetControl(sql);
    await resetUsers(sql);
    assertEquals(await readChargeableReleaseAdmission(serviceRoleReader(sql), now()), {
      status: "ineligible",
      reasonCode: "unverified",
    });
    const permit = await reserve(sql, U2, `attack-${RUN}-sql-only`);
    const result = await inTx(sql, U2, (tx) => apply(tx, edgeShot(shotId(), permit, "scored")));
    // Documented: the SQL layer does not consult the release authority, so a
    // client that bypasses the edge (direct PostgREST with its own JWT) can
    // still spend a free rating on an unvalidated scored result.
    assertEquals(result, "accepted");
    assertEquals(await permitState(sql, permit), "finalized/scored");
    assertEquals(await lifetimeScored(sql, U2), 1);
  });
});
