/**
 * stress-consent-grant-pg — the consent ledger against REAL Postgres.
 *
 * POST /v1/me/consent/grant is `insert into public.consent_records` followed by
 * a read-back ordered (created_at, id) — no RPC. What only a real database can
 * prove is exercised here on a disposable postgres:16 with shim_auth.sql and
 * EVERY migration applied (./xc_pg_up.sh), as role `authenticated` with a JWT
 * subject, exactly like PostgREST:
 *
 *   PG1  duplicate delivery: N concurrent identical grants all land (the ledger
 *        is append-only by design), and the route's fold of the N rows equals
 *        the fold of one — duplicates are idempotent in EFFECT;
 *   PG2  RLS: a user can neither insert a row for another user_id nor read
 *        another user's rows;
 *   PG3  append-only: UPDATE/DELETE by the client role are refused;
 *   PG4  edge/DB caps: index.ts sanitizes consentVersion and captureMode to 64
 *        code points, the DB CHECK `consent_records_bounds` caps both at 50 —
 *        the 51..64 band the edge accepts is rejected by the DB (→ the route's
 *        generic 503). Recorded as observed at both layers;
 *   PG5  fold correctness: STRESS_ITER seeded grant/withdraw sequences inserted
 *        in order; the route's SQL ordering reproduces the model's fold.
 *
 *   ./xc_pg_up.sh   # prints XC_PG_URL (never a hosted project)
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json stress_consent_grant_pg.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 * Results → <STRESS_OUT_DIR>/pg.json.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  CONSENT_SCOPES,
  type ConsentScope,
  envInt,
  fnv1a,
  histogram,
  Prng,
  writeJson,
} from "./stress_consent_grant_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const SEED = envInt("STRESS_SEED", 20260904);
const ITER = envInt("STRESS_ITER", 40);
const LANES = envInt("STRESS_PG_LANES", 12);

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const results: Record<string, unknown> = {};

const connect = (max: number): Sql =>
  postgres(PG_URL, { max, onnotice: () => {}, prepare: false });

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
  const profile = await sql.unsafe(
    `select 1 from public.profiles where id = '${userId}'`,
  );
  assertEquals(
    profile.length,
    1,
    "handle_new_user provisions the profile the ledger FK points at",
  );
}

/** Exactly the route's read-back (loadConsentRows). */
async function routeReadBack(tx: Tx, userId: string) {
  return (await tx.unsafe(
    `select scope, action, consent_version, created_at
       from public.consent_records
      where user_id = '${userId}'
      order by created_at asc, id asc`,
  )) as unknown as Array<
    {
      scope: string;
      action: string;
      consent_version: string | null;
      created_at: string;
    }
  >;
}

/** The route's fold (foldConsentStatus) over the rows the read-back returned. */
function fold(
  rows: Array<{ scope: string; action: string }>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const scope of CONSENT_SCOPES) {
    out[scope] = rows.filter((r) =>
      r.scope === scope
    ).at(-1)?.action === "grant";
  }
  return out;
}

/** The row the route builds for a grant (grantConsent's insert). */
const grantRow = (
  userId: string,
  scope: string,
  version: string,
  extra: Record<string, string | null> = {},
) => ({
  user_id: userId,
  scope,
  consent_version: version,
  action: "grant",
  source: "mobile_settings",
  device: JSON.stringify("iPhone16,2 iOS 19.0"),
  capture_mode: "all_captures",
  ...extra,
});

async function insertAs(
  tx: Tx,
  row: Record<string, string | null>,
): Promise<void> {
  await tx`insert into public.consent_records ${tx(row)}`;
}

const pgCode = (error: unknown): string =>
  typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : String(error);

const replay = (filter: string) =>
  `XC_PG_URL=<from ./xc_pg_up.sh> STRESS_SEED=${SEED} STRESS_ITER=${ITER} STRESS_PG_LANES=${LANES} deno test -A --no-check --config deno.json stress_consent_grant_pg.test.ts --filter "${filter}"`;

Deno.test({
  name:
    "stress-consent-grant-pg PG1: N concurrent duplicate grants all land and fold to one",
  ignore,
  async fn() {
    const sql = connect(LANES + 2);
    try {
      const rng = new Prng((SEED ^ fnv1a("pg1")) >>> 0);
      const userId = rng.uuid();
      await createUser(sql, userId);

      let ready = 0;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const outcomes = await Promise.all(
        Array.from({ length: LANES }, (_, lane) =>
          sql.begin(async (tx) => {
            await asUser(tx, userId);
            ready += 1;
            if (ready === LANES) open();
            await gate;
            try {
              await insertAs(
                tx,
                grantRow(userId, "model_training", "model-training-v1"),
              );
              return { lane, ok: true, code: null as string | null };
            } catch (error) {
              return { lane, ok: false, code: pgCode(error) };
            }
          })),
      );
      const rows = await sql.begin(async (tx) => {
        await asUser(tx, userId);
        return routeReadBack(tx, userId);
      });
      const landed = outcomes.filter((o) => o.ok).length;
      const withdraw = await sql.begin(async (tx) => {
        await asUser(tx, userId);
        await insertAs(tx, {
          user_id: userId,
          scope: "model_training",
          consent_version: null,
          action: "withdraw",
          source: "mobile_settings",
          device: null,
          capture_mode: null,
        });
        return fold(await routeReadBack(tx, userId));
      });
      results.pg1 = {
        lanes: LANES,
        landed,
        codes: histogram(outcomes.map((o) => o.code ?? "ok")),
        rowsVisible: rows.length,
        foldAfterDuplicates: fold(rows),
        foldAfterWithdraw: withdraw,
        replay: replay("PG1"),
      };
      assertEquals(landed, LANES, "append-only ledger accepts every delivery");
      assertEquals(rows.length, LANES, "the read-back sees every row");
      assertEquals(fold(rows), {
        video_analysis: false,
        model_training: true,
        evaluation_telemetry: false,
      });
      assertEquals(
        withdraw.model_training,
        false,
        "one withdraw after N duplicate grants wins",
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "stress-consent-grant-pg PG2: RLS — no cross-user insert, no cross-user read",
  ignore,
  async fn() {
    const sql = connect(2);
    try {
      const rng = new Prng((SEED ^ fnv1a("pg2")) >>> 0);
      const alice = rng.uuid();
      const bob = rng.uuid();
      await createUser(sql, alice);
      await createUser(sql, bob);
      await sql.begin(async (tx) => {
        await asUser(tx, alice);
        await insertAs(tx, grantRow(alice, "video_analysis", "v1"));
      });
      let crossInsert = "ok";
      try {
        await sql.begin(async (tx) => {
          await asUser(tx, bob);
          await insertAs(tx, grantRow(alice, "model_training", "v1"));
        });
      } catch (error) {
        crossInsert = pgCode(error);
      }
      const bobSeesAlice = await sql.begin(async (tx) => {
        await asUser(tx, bob);
        return routeReadBack(tx, alice);
      });
      const aliceRows = await sql.begin(async (tx) => {
        await asUser(tx, alice);
        return routeReadBack(tx, alice);
      });
      results.pg2 = {
        crossInsert,
        bobSeesAliceRows: bobSeesAlice.length,
        aliceRows: aliceRows.length,
        replay: replay("PG2"),
      };
      assertEquals(
        crossInsert,
        "42501",
        "insert for another user_id is refused by RLS",
      );
      assertEquals(
        bobSeesAlice.length,
        0,
        "RLS hides other users' rows even with an explicit user_id filter",
      );
      assertEquals(aliceRows.length, 1, "the cross-user insert did not land");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "stress-consent-grant-pg PG3: append-only — client UPDATE/DELETE refused",
  ignore,
  async fn() {
    const sql = connect(2);
    try {
      const rng = new Prng((SEED ^ fnv1a("pg3")) >>> 0);
      const userId = rng.uuid();
      await createUser(sql, userId);
      await sql.begin(async (tx) => {
        await asUser(tx, userId);
        await insertAs(tx, grantRow(userId, "video_analysis", "v1"));
      });
      const attempt = async (statement: string): Promise<string> => {
        try {
          await sql.begin(async (tx) => {
            await asUser(tx, userId);
            await tx.unsafe(statement);
          });
          return "ok";
        } catch (error) {
          return pgCode(error);
        }
      };
      const update = await attempt(
        `update public.consent_records set action = 'withdraw' where user_id = '${userId}'`,
      );
      const del = await attempt(
        `delete from public.consent_records where user_id = '${userId}'`,
      );
      const ownerUpdate = await (async () => {
        try {
          await sql.unsafe(
            `update public.consent_records set action = 'withdraw' where user_id = '${userId}'`,
          );
          return "ok";
        } catch (error) {
          return pgCode(error);
        }
      })();
      const rows = await sql.begin(async (tx) => {
        await asUser(tx, userId);
        return routeReadBack(tx, userId);
      });
      results.pg3 = {
        clientUpdate: update,
        clientDelete: del,
        ownerUpdate,
        rows: rows.length,
        action: rows[0]?.action,
        replay: replay("PG3"),
      };
      assertEquals(update, "42501", "authenticated has no UPDATE grant");
      assertEquals(del, "42501", "authenticated has no DELETE grant");
      assert(
        ownerUpdate !== "ok",
        `append-only trigger must refuse even the owner (${ownerUpdate})`,
      );
      assertEquals(rows.length, 1);
      assertEquals(rows[0].action, "grant");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "stress-consent-grant-pg PG4: edge caps (64) vs DB CHECK (50) on consent_version / capture_mode",
  ignore,
  async fn() {
    const sql = connect(2);
    try {
      const rng = new Prng((SEED ^ fnv1a("pg4")) >>> 0);
      const userId = rng.uuid();
      await createUser(sql, userId);
      const tryInsert = async (
        row: Record<string, string | null>,
      ): Promise<string> => {
        try {
          await sql.begin(async (tx) => {
            await asUser(tx, userId);
            await insertAs(tx, row);
          });
          return "ok";
        } catch (error) {
          return pgCode(error);
        }
      };
      // The edge (index.ts grantConsent) keeps up to 64 code points of
      // consentVersion / captureMode and 512 of device, 64 of source.
      const table: Array<{ column: string; length: number; code: string }> = [];
      for (const length of [50, 51, 64]) {
        table.push({
          column: "consent_version",
          length,
          code: await tryInsert(
            grantRow(userId, "model_training", "v".repeat(length)),
          ),
        });
        table.push({
          column: "capture_mode",
          length,
          code: await tryInsert(
            grantRow(userId, "model_training", "v1", {
              capture_mode: "c".repeat(length),
            }),
          ),
        });
        table.push({
          column: "source",
          length,
          code: await tryInsert(
            grantRow(userId, "model_training", "v1", {
              source: "s".repeat(length),
            }),
          ),
        });
      }
      table.push({
        column: "device",
        length: 512,
        code: await tryInsert(
          grantRow(userId, "model_training", "v1", {
            device: JSON.stringify("d".repeat(512)),
          }),
        ),
      });
      results.pg4 = {
        edgeCapCodePoints: {
          consent_version: 64,
          capture_mode: 64,
          source: 64,
          device: 512,
        },
        table,
        replay: replay("PG4"),
      };

      const codeFor = (column: string, length: number) =>
        table.find((t) => t.column === column && t.length === length)?.code;
      // Inside both caps: accepted.
      assertEquals(codeFor("consent_version", 50), "ok");
      assertEquals(codeFor("capture_mode", 50), "ok");
      assertEquals(codeFor("source", 64), "ok");
      assertEquals(codeFor("device", 512), "ok");
      // The band the edge accepts (51..64) — asserted as the contract the edge
      // implies: a value the edge validated and sanitized must be storable.
      const band = table.filter(
        (t) =>
          (t.column === "consent_version" || t.column === "capture_mode") &&
          t.length > 50 && t.code !== "ok",
      );
      assertEquals(
        band.map((t) => `${t.column}[${t.length}] → ${t.code}`),
        [],
        "values inside the edge's 64-code-point cap are rejected by consent_records_bounds",
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "stress-consent-grant-pg PG5: seeded grant/withdraw sequences fold identically in SQL and model",
  ignore,
  async fn() {
    const sql = connect(2);
    try {
      const rng = new Prng((SEED ^ fnv1a("pg5")) >>> 0);
      const rows: Array<Record<string, unknown>> = [];
      const mismatches: string[] = [];
      for (let i = 0; i < ITER; i += 1) {
        const seqSeed = rng.int(1, 0x7fffffff);
        const local = new Prng(seqSeed);
        const userId = local.uuid();
        await createUser(sql, userId);
        const steps = local.int(1, 12);
        const model: Record<string, boolean> = Object.fromEntries(
          CONSENT_SCOPES.map((s) => [s, false]),
        );
        const trail: string[] = [];
        for (let s = 0; s < steps; s += 1) {
          const scope: ConsentScope = local.pick(CONSENT_SCOPES);
          const grant = local.chance(0.6);
          trail.push(`${grant ? "+" : "-"}${scope}`);
          await sql.begin(async (tx) => {
            await asUser(tx, userId);
            await insertAs(
              tx,
              grant ? grantRow(userId, scope, `v${local.int(1, 9)}`) : {
                user_id: userId,
                scope,
                consent_version: null,
                action: "withdraw",
                source: null,
                device: null,
                capture_mode: null,
              },
            );
          });
          model[scope] = grant;
        }
        const observed = await sql.begin(async (tx) => {
          await asUser(tx, userId);
          return fold(await routeReadBack(tx, userId));
        });
        const ok = CONSENT_SCOPES.every((s) => observed[s] === model[s]);
        if (!ok) {
          mismatches.push(
            `seq seed ${seqSeed}: ${trail.join(" ")} → sql ${
              JSON.stringify(observed)
            } model ${JSON.stringify(model)}`,
          );
        }
        rows.push({
          seqSeed,
          steps,
          trail: trail.join(" "),
          observed,
          model,
          ok,
        });
      }
      results.pg5 = {
        sequences: ITER,
        mismatches,
        rows,
        replay: replay("PG5"),
      };
      assertEquals(mismatches, []);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "stress-consent-grant-pg: write pg.json",
  ignore,
  async fn() {
    const path = await writeJson("pg.json", {
      campaign: "stress-consent-grant-pg",
      seed: SEED,
      iterations: ITER,
      lanes: LANES,
      results,
    });
    console.log(`stress-consent-grant-pg → ${path}`);
  },
});
