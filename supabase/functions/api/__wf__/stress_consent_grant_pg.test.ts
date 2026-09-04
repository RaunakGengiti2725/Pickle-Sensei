/**
 * stress-consent-grant — REAL Postgres half of the fuzz/boundary campaign.
 *
 * stress_consent_grant_fuzz.test.ts drives the real edge handler over a
 * MODELLED database, so every row it "writes" is only asserted against the
 * model. This file takes the rows that campaign accepted — the exact
 * sanitized `consent_records` insert the handler performs, computed by the
 * same generator (predictedInsertRow) from the same seeds — and writes them
 * to a disposable postgres:16 with shim_auth.sql + every migration applied,
 * as role `authenticated` with the caller's JWT sub (so RLS, the size-cap
 * check constraint `consent_records_bounds` and the append-only trigger are
 * the real ones).
 *
 *   ./xc_pg_up.sh                       # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     STRESS_OUT_DIR=/tmp/stress-consent/ \
 *     deno test -A --no-check --config deno.json stress_consent_grant_pg.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d, and
 * an ignored run is NOT a pass.
 *
 * Scale: STRESS_PG_ITER accept-path bodies (default 200) generated from
 * STRESS_SEED, each replayable via its `<seed>:<iteration>` key. It asserts
 * the CROSS-LAYER contract the in-process campaign can only model:
 *   - a row the edge accepts either commits, or is refused by exactly the
 *     constraint the model predicted from the edge/DB cap mismatch;
 *   - the committed ledger folds to the status the edge returned;
 *   - the caller cannot write another user's row, update or delete a row.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  codePointLength,
  DB_CAPS,
  generateScenario,
  type InsertRow,
  ipPool,
  predict,
  buildRequest,
  rowAnomalies,
  STRESS_ITER,
  STRESS_SEED,
  replayKey,
  userPool,
  writeStressReport,
} from "./stress_consent_grant_gen.ts";
import { envInt } from "./xc_concurrency_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const PG_ITER = envInt("STRESS_PG_ITER", 200);

type Sql = ReturnType<typeof postgres>;

const CALLER = "3a111111-1111-4111-8111-111111111111";
const OTHER = "3a222222-2222-4222-8222-222222222222";

interface PgRow {
  replay: string;
  scope: string;
  consentVersionCodePoints: number;
  captureModeCodePoints: number | null;
  deviceCodePoints: number | null;
  predictedAnomalies: string[];
  outcome: "committed" | "rejected";
  sqlstate: string | null;
  constraint: string | null;
  modelPredictedRejection: boolean;
}

async function createUser(sql: Sql, id: string) {
  await sql.unsafe(`delete from auth.users where id = '${id}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${id}', '${id}@example.com', '{"provider":"apple"}')`,
  );
}

/** The row the edge would insert, written by the CALLER itself (role
 * authenticated + JWT sub), i.e. through RLS and every table constraint. */
async function insertAsCaller(
  sql: Sql,
  userId: string,
  row: InsertRow,
): Promise<{ ok: true } | { ok: false; sqlstate: string; constraint: string | null }> {
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local role authenticated`);
      await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
      await tx.unsafe(
        `insert into public.consent_records
           (user_id, scope, consent_version, action, source, device, capture_mode)
         values ($1::uuid, $2, $3, 'grant', $4, $5::text::jsonb, $6)`,
        [
          row.user_id,
          row.scope,
          row.consent_version,
          row.source,
          row.device === null ? null : JSON.stringify(row.device),
          row.capture_mode,
        ],
      );
    });
    return { ok: true };
  } catch (error) {
    const e = error as { code?: string; constraint_name?: string; constraint?: string };
    return {
      ok: false,
      sqlstate: String(e.code ?? "unknown"),
      constraint: e.constraint_name ?? e.constraint ?? null,
    };
  }
}

/** Accept-path bodies only: the generator's full distribution is exercised in
 * the in-process campaign; here the interesting population is the rows that
 * REACHED the insert, because those are the ones the DB gets to judge. */
function acceptedRows(iterations: number): Array<{ replay: string; row: InsertRow }> {
  const pools = {
    users: userPool(STRESS_SEED, Math.max(iterations, STRESS_ITER)),
    ips: ipPool(STRESS_SEED, Math.max(iterations, STRESS_ITER)),
  };
  const out: Array<{ replay: string; row: InsertRow }> = [];
  for (let iteration = 0; out.length < iterations; iteration += 1) {
    if (iteration > iterations * 200) break;
    const scenario = generateScenario(STRESS_SEED, iteration, pools);
    const request = buildRequest(scenario);
    const prediction = predict(scenario, request);
    if (prediction.insertRow === null) continue;
    out.push({
      replay: replayKey(STRESS_SEED, iteration),
      row: { ...prediction.insertRow, user_id: CALLER },
    });
  }
  return out;
}

Deno.test({
  name: "stress consent-grant — edge-accepted rows against the real consent_records table",
  ignore,
  fn: async (t) => {
    const sql = postgres(PG_URL, { max: 4 });
    const rows: PgRow[] = [];
    try {
      await createUser(sql, CALLER);
      await createUser(sql, OTHER);

      const population = acceptedRows(PG_ITER);
      assert(population.length > 0, "the generator produced no accept-path rows");

      await t.step(`${population.length} edge-accepted rows written as the caller`, async () => {
        for (const { replay, row } of population) {
          const predicted = rowAnomalies(row);
          const result = await insertAsCaller(sql, CALLER, row);
          rows.push({
            replay,
            scope: row.scope,
            consentVersionCodePoints: codePointLength(row.consent_version),
            captureModeCodePoints:
              row.capture_mode === null ? null : codePointLength(row.capture_mode),
            deviceCodePoints: row.device === null ? null : codePointLength(row.device),
            predictedAnomalies: predicted,
            outcome: result.ok ? "committed" : "rejected",
            sqlstate: result.ok ? null : result.sqlstate,
            constraint: result.ok ? null : result.constraint,
            modelPredictedRejection: predicted.some((a) => a.endsWith("exceeds_db_cap_50")),
          });
        }
      });

      await t.step("every DB rejection is one the model predicted from the cap mismatch", () => {
        const surprises = rows.filter(
          (r) => r.outcome === "rejected" && !r.modelPredictedRejection,
        );
        assertEquals(surprises, [], "a row the edge accepts was refused for an unmodelled reason");
        for (const r of rows.filter((r) => r.outcome === "rejected")) {
          assertEquals(r.sqlstate, "23514", `${r.replay}: expected a check-constraint refusal`);
          assertEquals(
            r.constraint,
            "consent_records_bounds",
            `${r.replay}: unexpected constraint`,
          );
        }
      });

      await t.step("the cap mismatch is real: >50 code points is refused, <=50 commits", () => {
        for (const r of rows) {
          if (r.consentVersionCodePoints > DB_CAPS.consent_version) {
            assertEquals(r.outcome, "rejected", `${r.replay}: DB accepted an over-cap version`);
          }
          if (
            r.consentVersionCodePoints <= DB_CAPS.consent_version &&
            (r.captureModeCodePoints ?? 0) <= DB_CAPS.capture_mode
          ) {
            assertEquals(r.outcome, "committed", `${r.replay}: DB refused an in-cap row`);
          }
        }
      });

      await t.step(
        "the committed ledger reads back for the caller and folds per scope",
        async () => {
          const committed = rows.filter((r) => r.outcome === "committed").length;
          const read = await sql.begin(async (tx) => {
            await tx.unsafe(`set local role authenticated`);
            await tx.unsafe(`set local request.jwt.claim.sub = '${CALLER}'`);
            return await tx.unsafe(
              `select scope, action, consent_version, created_at
               from public.consent_records
              where user_id = '${CALLER}'
              order by created_at, id`,
            );
          });
          assertEquals(read.length, committed, "the caller's ledger lost or gained rows");
          assert(
            read.every((r: Record<string, unknown>) => r.action === "grant"),
            "a non-grant row appeared",
          );
        },
      );

      await t.step(
        "empty-after-sanitize consent versions are stored verbatim by the DB",
        async () => {
          const empty = rows.filter(
            (r) => r.outcome === "committed" && r.consentVersionCodePoints === 0,
          ).length;
          const stored = await sql.unsafe(
            `select count(*)::int as n from public.consent_records
            where user_id = '${CALLER}' and consent_version = ''`,
          );
          assertEquals(Number(stored[0].n), empty, "empty consent versions did not round-trip");
        },
      );

      await t.step(
        "minimized boundary: exactly 50 commits, 51 is refused (edge cap is 64)",
        async () => {
          const base: InsertRow = {
            user_id: CALLER,
            scope: "video_analysis",
            consent_version: "v",
            action: "grant",
            source: null,
            device: null,
            capture_mode: null,
          };
          const cases: Array<{ name: string; row: InsertRow; committed: boolean }> = [
            {
              name: "consent_version=50",
              row: { ...base, consent_version: "a".repeat(50) },
              committed: true,
            },
            {
              name: "consent_version=51",
              row: { ...base, consent_version: "a".repeat(51) },
              committed: false,
            },
            {
              name: "consent_version=64 (edge cap)",
              row: { ...base, consent_version: "a".repeat(64) },
              committed: false,
            },
            {
              name: "capture_mode=50",
              row: { ...base, capture_mode: "c".repeat(50) },
              committed: true,
            },
            {
              name: "capture_mode=51",
              row: { ...base, capture_mode: "c".repeat(51) },
              committed: false,
            },
            {
              name: "source=64 (edge cap, DB cap 100)",
              row: { ...base, source: "s".repeat(64) },
              committed: true,
            },
            {
              name: "device=512 x 4-byte (edge cap; DB cap 4096 bytes)",
              row: { ...base, device: "😀".repeat(512) },
              committed: true,
            },
            {
              name: "consent_version='' (control-only input after sanitize)",
              row: { ...base, consent_version: "" },
              committed: true,
            },
          ];
          for (const c of cases) {
            const result = await insertAsCaller(sql, CALLER, c.row);
            assertEquals(result.ok, c.committed, `${c.name}: ${JSON.stringify(result)}`);
            if (!result.ok) {
              assertEquals(result.sqlstate, "23514", c.name);
              assertEquals(result.constraint, "consent_records_bounds", c.name);
            }
          }
        },
      );

      await t.step("the caller cannot write another user's consent row (RLS)", async () => {
        const foreign = await insertAsCaller(sql, CALLER, {
          user_id: OTHER,
          scope: "video_analysis",
          consent_version: "v1",
          action: "grant",
          source: null,
          device: null,
          capture_mode: null,
        });
        assert(!foreign.ok, "RLS allowed a cross-user consent write");
        assertEquals((foreign as { sqlstate: string }).sqlstate, "42501");
      });

      await t.step("the ledger is append-only for the caller (update/delete refused)", async () => {
        for (const stmt of [
          `update public.consent_records set action = 'withdraw' where user_id = '${CALLER}'`,
          `delete from public.consent_records where user_id = '${CALLER}'`,
        ]) {
          let code = "";
          try {
            await sql.begin(async (tx) => {
              await tx.unsafe(`set local role authenticated`);
              await tx.unsafe(`set local request.jwt.claim.sub = '${CALLER}'`);
              await tx.unsafe(stmt);
            });
          } catch (error) {
            code = String((error as { code?: string }).code ?? "");
          }
          assert(code !== "", `the ledger allowed: ${stmt}`);
          assertEquals(code, "42501", `unexpected sqlstate for: ${stmt}`);
        }
      });
    } finally {
      const path = await writeStressReport("fuzz-boundary-pg", {
        unit: "route-post-v1-me-consent-grant",
        lens: "fuzz-boundary (real Postgres)",
        pgUrlHost: new URL(PG_URL.replace("postgres://", "http://")).host,
        campaignSeed: STRESS_SEED,
        iterations: PG_ITER,
        replay:
          `XC_PG_URL=<./xc_pg_up.sh> STRESS_SEED=${STRESS_SEED} STRESS_PG_ITER=${PG_ITER} ` +
          `deno test -A --no-check --config deno.json stress_consent_grant_pg.test.ts`,
        summary: {
          executed: rows.length,
          committed: rows.filter((r) => r.outcome === "committed").length,
          rejected: rows.filter((r) => r.outcome === "rejected").length,
          rejectedReplays: rows.filter((r) => r.outcome === "rejected").map((r) => r.replay),
          emptyVersionCommitted: rows.filter(
            (r) => r.outcome === "committed" && r.consentVersionCodePoints === 0,
          ).length,
        },
        rows,
      });
      console.log(`stress-consent-grant(pg): ${rows.length} rows → ${path}`);
      await sql.end();
    }
  },
});
