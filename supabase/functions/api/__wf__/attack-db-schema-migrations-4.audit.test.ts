/**
 * ADVERSARIAL PASS 3/3 — `db-schema-migrations` (attack tester #4).
 *
 * Every test below performs one of the assigned attacks DIRECTLY against
 * `public.apply_synced_shot(jsonb)` (bypassing the edge parser, exactly like
 * a PostgREST caller holding the anon key + a user access token would) on a
 * throwaway Postgres with the shim + every migration applied, and pins the
 * OBSERVED behaviour:
 *
 *   - `HELD` tests assert the invariant the migrations promise.
 *   - `REPRO` tests pin a confirmed gap so the suite stays green today and
 *     FLIPS (fails) the moment the gap is closed — the repo's audit-test
 *     convention (see db_migrations_rls_indexes.audit.test.ts header). Each
 *     REPRO test's docblock states the expected (fixed) behaviour.
 *
 * Every test logs one machine-readable line `[attack4] S<n> HELD|BROKEN …`
 * which wf-attack-db-schema-migrations-4.sh folds into a summary JSON.
 *
 * Run (see wf-attack-db-schema-migrations-4.sh for the one-shot harness):
 *   docker run -d --name pickle-attack4 -p 55433:5432 -e POSTGRES_PASSWORD=pg postgres:16
 *   docker cp supabase/tests pickle-attack4:/tests && docker cp supabase/migrations pickle-attack4:/migrations
 *   docker exec pickle-attack4 bash -c 'psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql \
 *     && for f in /migrations/*.sql; do psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"; done'
 *   PICKLE_AUDIT_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --config supabase/functions/api/__wf__/deno.json \
 *       supabase/functions/api/__wf__/attack-db-schema-migrations-4.audit.test.ts
 *
 * Without PICKLE_AUDIT_PG_URL every test is skipped (ignore: true) — a skip
 * is NOT a pass.
 *
 * Seeded randomness: ATTACK4_SEED (default 0x4d812e1a — the audited commit)
 * drives every random id / confidence / shuffle via mulberry32.
 */
import postgres from "postgres";
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";

const PG_URL = Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

const REPO_ROOT = new URL("../../../../", import.meta.url);
const EDGE_INDEX = new URL("supabase/functions/api/index.ts", REPO_ROOT);
const MOBILE_SYNC = new URL("apps/mobile/src/data/sync.ts", REPO_ROOT);

// ── seeded randomness ──────────────────────────────────────────────────────
const SEED =
  Number.parseInt(Deno.env.get("ATTACK4_SEED") ?? "0x4d812e1a", 16) >>> 0;
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const hex = (n: number) =>
  Math.floor(rand() * 16 ** n).toString(16).padStart(n, "0");
/** RFC-4122-shaped v4 uuid from the seeded PRNG (accepted by the edge UUID_RE). */
const seededUuid = () =>
  `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(rand() * 4)).toString(16)}${
    hex(3)
  }-${hex(12)}`;
console.log(`[attack4] seed=0x${SEED.toString(16)}`);

// ── fixtures ───────────────────────────────────────────────────────────────
const ALICE = "00000000-0000-4000-8000-0000000004a1";
const BOB = "00000000-0000-4000-8000-0000000004b0";
const BOB_SESSION = "00000000-0000-4000-8000-0000000004b5";

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

type Sql = ReturnType<typeof postgres>;

function log(scenario: string, verdict: "HELD" | "BROKEN", detail: string) {
  console.log(`[attack4] ${scenario} ${verdict} ${detail}`);
}

/** Runs `fn` inside one transaction that is always rolled back. */
async function withRollback(
  sql: Sql,
  fn: (tx: Sql) => Promise<void>,
): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx as unknown as Sql);
      throw new Error("__rollback__");
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "__rollback__") {
      throw error;
    }
  }
}

async function seedUser(
  tx: Sql,
  userId: string,
  opts: { provider?: string; providerId?: string; premium?: boolean } = {},
): Promise<void> {
  const provider = opts.provider ?? "google";
  const providerId = opts.providerId ?? `sub-${userId}`;
  await tx.unsafe(
    `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
     values ('${userId}', '${userId}@example.com', '{}', '{"provider":"${provider}"}')
     on conflict do nothing`,
  );
  await tx.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('${provider}', '${providerId}', '${userId}', '{"sub":"${providerId}"}')
     on conflict do nothing`,
  );
  if (opts.premium) {
    await tx.unsafe(
      `insert into public.billing_entitlements (user_id, premium) values ('${userId}', true)
       on conflict (user_id) do update set premium = true, expires_at = null`,
    );
  }
}

async function asUser(tx: Sql, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

/** Seeds Alice (optionally premium) and Bob (+ a Bob-owned session), then runs
 * `fn` as Alice inside a rolled-back transaction. */
async function withAlice(
  sql: Sql,
  fn: (tx: Sql) => Promise<void>,
  opts: { premium?: boolean } = {},
): Promise<void> {
  await withRollback(sql, async (tx) => {
    await seedUser(tx, ALICE, { premium: opts.premium });
    await seedUser(tx, BOB, { provider: "apple" });
    await tx.unsafe(
      `insert into public.sessions (id, user_id, started_at) values ('${BOB_SESSION}', '${BOB}', now())`,
    );
    await asUser(tx, ALICE);
    await fn(tx);
  });
}

async function reserve(tx: Sql, key: string): Promise<string> {
  const rows = await tx.unsafe(
    `select result, permit_id from public.reserve_analysis_permit('${key}')`,
  );
  assertEquals(
    rows[0].result,
    "accepted",
    `reserve(${key}) → ${rows[0].result}`,
  );
  return rows[0].permit_id as string;
}

async function apply(
  tx: Sql,
  payload: Record<string, unknown>,
): Promise<string> {
  // postgres.js JSON.stringify()s parameters bound to json/jsonb itself — pass
  // the object, not a pre-serialised string (that would double-encode).
  const rows = await tx.unsafe(
    `select public.apply_synced_shot($1::jsonb) as status`,
    [payload as unknown as string],
  );
  return rows[0].status as string;
}

async function permitState(
  tx: Sql,
  permitId: string,
): Promise<{ status: string; outcome: string | null }> {
  const rows = await tx.unsafe(
    `select status, outcome from public.analysis_permits where id = '${permitId}'`,
  );
  return { status: rows[0].status, outcome: rows[0].outcome };
}

async function count(tx: Sql, table: string, where: string): Promise<number> {
  const rows = await tx.unsafe(
    `select count(*)::int as n from ${table} where ${where}`,
  );
  return rows[0].n as number;
}

function shotPayload(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: seededUuid(),
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

function connect(): Sql {
  return postgres(PG_URL, { max: 1, onnotice: () => {} });
}

// ═══════════════════════════════════════════════════════════════════════════
// S1 — schema-invalid scored payloads straight into the RPC
// ═══════════════════════════════════════════════════════════════════════════

Deno.test({
  name:
    "S1 HELD: overallScore null / 10.01 / resultKind garbage → shot.write_failed:*, zero rows, permit reserved, ledger untouched",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await withAlice(sql, async (tx) => {
        const permit = await reserve(tx, "s1");
        const attacks: Array<[string, Record<string, unknown>]> = [
          ["overallScore=null", { overallScore: null, resultKind: "scored" }],
          ["overallScore=10.01", { overallScore: 10.01 }],
          ["resultKind=garbage", { resultKind: "garbage" }],
          ["overallScore=-0.01", { overallScore: -0.01 }],
          ["overallScore=NaN-string", { overallScore: "NaN" }],
          ["confidence=1.5", { confidence: 1.5 }],
          ["cameraView=top", { cameraView: "top" }],
          ["endMs=2^31", { endMs: 2147483648 }],
          ["shotType=null", { shotType: null }],
          ["versionVector missing", { versionVector: {} }],
        ];
        for (const [label, over] of attacks) {
          const payload = shotPayload({ analysisPermitId: permit, ...over });
          const status = await apply(tx, payload);
          assert(
            status.startsWith("shot.write_failed:"),
            `${label} → ${status}`,
          );
          assertEquals(
            await count(tx, "public.shots", `id = '${payload.id}'`),
            0,
            label,
          );
          assertEquals(
            await count(tx, "public.shot_phases", `shot_id = '${payload.id}'`),
            0,
            label,
          );
          const p = await permitState(tx, permit);
          assertEquals(p.status, "reserved", `${label} permit`);
          assertEquals(p.outcome, null, `${label} permit outcome`);
          log("S1", "HELD", `${label} → ${status}`);
        }
        const ledger = await tx.unsafe(
          `select public.lifetime_scored_count() as n`,
        );
        assertEquals(
          ledger[0].n,
          0,
          "lifetime_scored_count after rejected writes",
        );
        // The permit is still spendable: a valid retry consumes it.
        const ok = await apply(tx, shotPayload({ analysisPermitId: permit }));
        assertEquals(ok, "accepted");
        assertEquals((await permitState(tx, permit)).status, "finalized");
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "S1 REPRO(P3): low_confidence abstention with a non-null overallScore is stored (no CHECK) — but stays out of every scored consumer",
  ignore,
  async fn() {
    // Expected (fixed): a CHECK `result_kind <> 'low_confidence' or overall_score is null`
    // mirroring parseSyncShot ("overallScore must be null when resultKind=low_confidence").
    const sql = connect();
    try {
      await withAlice(sql, async (tx) => {
        const permit = await reserve(tx, "s1lc");
        const payload = shotPayload({
          analysisPermitId: permit,
          resultKind: "low_confidence",
          overallScore: 9.99,
        });
        const status = await apply(tx, payload);
        assertEquals(status, "accepted");
        const row = await tx.unsafe(
          `select overall_score::text as s from public.shots where id = '${payload.id}'`,
        );
        assertEquals(row[0].s, "9.99");
        // Consumers filter on result_kind='scored', so the stray score is inert.
        assertEquals(
          await count(tx, "public.progress_daily", `user_id = '${ALICE}'`),
          0,
        );
        assertEquals(
          await count(
            tx,
            "public.player_technique_rating",
            `user_id = '${ALICE}'`,
          ),
          0,
        );
        assertEquals(
          await count(tx, "public.player_rank_state", `user_id = '${ALICE}'`),
          0,
        );
        const ledger = await tx.unsafe(
          `select public.lifetime_scored_count() as n`,
        );
        assertEquals(ledger[0].n, 0);
        assertEquals((await permitState(tx, permit)).outcome, "low_confidence");
        log(
          "S1",
          "BROKEN",
          "low_confidence+overallScore=9.99 accepted and stored (no CHECK); consumers unaffected (P3)",
        );
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "S1 static pin: edge collapses shot.write_failed:* to a retryable rejection and the outbox never spends attempts on it (poison row retries forever)",
  ignore,
  async fn() {
    const edge = await Deno.readTextFile(EDGE_INDEX);
    const sync = await Deno.readTextFile(MOBILE_SYNC);
    // Edge: any RPC status other than the enumerated contract verdicts → "shot.write_failed" + "will retry".
    assertStringIncludes(
      edge,
      `"shot.write_failed",\n        "The analysis could not be saved right now. It stays on this device and will retry."`,
    );
    assert(
      !/"shot\.write_failed"\s*:/.test(
        edge.slice(
          edge.indexOf("SYNC_STATUS_MESSAGES"),
          edge.indexOf("SYNC_STATUS_MESSAGES") + 900,
        ),
      ),
      "shot.write_failed is not a mapped contract verdict — it is the catch-all",
    );
    // Mobile: shot.write_failed is TRANSIENT → attempts never increment → no bound.
    const transient = sync.slice(
      sync.indexOf("TRANSIENT_SYNC_REJECTION_CODES"),
      sync.indexOf("]);", sync.indexOf("TRANSIENT_SYNC_REJECTION_CODES")),
    );
    assertStringIncludes(transient, `'shot.write_failed'`);
    assertStringIncludes(sync, "OUTBOX_MAX_ATTEMPTS = 8");
    // Drain picks the 50 lowest ids with attempts < 8: a transient-failing row keeps its slot forever.
    assert(
      /WHERE owner_key = \? AND attempts < \? ORDER BY id ASC LIMIT 50/.test(
        sync,
      ),
    );
    // recordRowFailure(permanent=false) only records last_error.
    assert(
      /if \(permanent\) \{\s*await db\.execute\(\s*`UPDATE outbox SET attempts = attempts \+ 1/
        .test(sync),
    );
    assert(
      /\} else \{\s*await db\.execute\(\s*`UPDATE outbox SET last_error = \?/
        .test(sync),
    );
    log(
      "S1",
      "HELD",
      "edge→shot.write_failed (retryable); outbox: attempts never incremented → permanent poison row retried on every drain, occupies one of the 50 head-of-line slots forever (INFERRED from source)",
    );
  },
});

Deno.test({
  name:
    "S1 REPRO(P3): capturedAt strings the edge parser accepts (Date.parse) but Postgres rejects → permanent poison row labelled retryable",
  ignore,
  async fn() {
    // Expected (fixed): parseSyncShot requires the canonical toISOString shape
    // (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/) so nothing the
    // edge accepts can fail the timestamptz cast.
    const edge = await Deno.readTextFile(EDGE_INDEX);
    assertStringIncludes(
      edge,
      `typeof value === "string" && !Number.isNaN(Date.parse(value))`,
      "isIsoDate is Date.parse",
    );
    const isIsoDate = (value: unknown): value is string =>
      typeof value === "string" && !Number.isNaN(Date.parse(value));
    const sql = connect();
    try {
      await withAlice(sql, async (tx) => {
        const permit = await reserve(tx, "s1ts");
        const edgeAcceptedDbRejected = [
          "Tue Sep 01 2026 10:00:00 GMT+0000 (Coordinated Universal Time)", // Date#toString()
          "+275760-09-13T00:00:00.000Z", // JS max date, toISOString() shape
          "-000001-01-01T00:00:00.000Z", // negative extended year
        ];
        for (const capturedAt of edgeAcceptedDbRejected) {
          assert(isIsoDate(capturedAt), `edge would accept ${capturedAt}`);
          const payload = shotPayload({ analysisPermitId: permit, capturedAt });
          const status = await apply(tx, payload);
          assert(
            status.startsWith("shot.write_failed:"),
            `${capturedAt} → ${status}`,
          );
          assertEquals(
            await count(tx, "public.shots", `id = '${payload.id}'`),
            0,
          );
          assertEquals((await permitState(tx, permit)).status, "reserved");
          log(
            "S1",
            "BROKEN",
            `edge-valid capturedAt ${
              JSON.stringify(capturedAt)
            } → ${status} (retryable forever)`,
          );
        }
      });
    } finally {
      await sql.end();
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// S2 — replay an owned shot id with a different permit and a higher score
// ═══════════════════════════════════════════════════════════════════════════

Deno.test({
  name:
    "S2 HELD: replaying an owned shot id with another permit + higher score returns accepted, rewrites nothing, leaves permit 2 reserved",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await withAlice(sql, async (tx) => {
        const p1 = await reserve(tx, "s2a");
        const p2 = await reserve(tx, "s2b");
        const id = seededUuid();
        const first = shotPayload({
          id,
          analysisPermitId: p1,
          overallScore: 4.25,
          shotType: "dink",
          phases: [{
            key: "contact",
            startMs: 10,
            representativeMs: 20,
            endMs: 30,
            confidence: 0.4,
          }],
          checkpoints: [{
            key: "paddle",
            score: 40,
            confidence: 0.4,
            band: "yellow",
            direction: "up",
            severity: 0.2,
            applicable: true,
          }],
        });
        assertEquals(await apply(tx, first), "accepted");
        const before = await tx.unsafe(
          `select row_to_json(s) as j from public.shots s where id = '${id}'`,
        );
        const phasesBefore = await tx.unsafe(
          `select row_to_json(p) as j from public.shot_phases p where shot_id = '${id}' order by phase_key`,
        );
        const cpsBefore = await tx.unsafe(
          `select row_to_json(c) as j from public.shot_checkpoints c where shot_id = '${id}' order by checkpoint_key`,
        );

        const replay = shotPayload({
          id,
          analysisPermitId: p2,
          overallScore: 9.75,
          shotType: "serve",
          cameraView: "rear_oblique",
          capturedAt: "2026-09-02T00:00:00.000Z",
          resultKind: "scored",
          phases: [
            {
              key: "contact",
              startMs: 1,
              representativeMs: 2,
              endMs: 3,
              confidence: 0.99,
            },
            {
              key: "follow_through",
              startMs: 4,
              representativeMs: 5,
              endMs: 6,
              confidence: 0.99,
            },
          ],
          checkpoints: [{
            key: "paddle",
            score: 100,
            confidence: 1,
            band: "green",
            direction: "x",
            severity: 0,
            applicable: true,
          }],
        });
        assertEquals(await apply(tx, replay), "accepted");

        const after = await tx.unsafe(
          `select row_to_json(s) as j from public.shots s where id = '${id}'`,
        );
        assertEquals(after[0].j, before[0].j, "shot row rewritten by replay");
        const phasesAfter = await tx.unsafe(
          `select row_to_json(p) as j from public.shot_phases p where shot_id = '${id}' order by phase_key`,
        );
        assertEquals(
          phasesAfter.map((r) => r.j),
          phasesBefore.map((r) => r.j),
          "phases rewritten/added by replay",
        );
        const cpsAfter = await tx.unsafe(
          `select row_to_json(c) as j from public.shot_checkpoints c where shot_id = '${id}' order by checkpoint_key`,
        );
        assertEquals(
          cpsAfter.map((r) => r.j),
          cpsBefore.map((r) => r.j),
          "checkpoints rewritten by replay",
        );
        assertEquals(
          await count(tx, "public.shots", `user_id = '${ALICE}'`),
          1,
        );

        assertEquals(await permitState(tx, p1), {
          status: "finalized",
          outcome: "scored",
        });
        assertEquals(await permitState(tx, p2), {
          status: "reserved",
          outcome: null,
        }, "permit 2 must be untouched");
        const ledger = await tx.unsafe(
          `select public.lifetime_scored_count() as n`,
        );
        assertEquals(
          ledger[0].n,
          1,
          "replay must not double-count the free rating",
        );
        // Rank state reflects the ORIGINAL score only.
        const rank = await tx.unsafe(
          `select rating::text as r, scored_shot_count as c from public.player_rank_state where user_id = '${ALICE}'`,
        );
        assertEquals(rank[0].c, 1);
        assertEquals(rank[0].r, "4.25");
        log(
          "S2",
          "HELD",
          "replay accepted; shot/phases/checkpoints byte-identical; permit2 reserved; ledger=1; rank=4.25",
        );
      });
    } finally {
      await sql.end();
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// S3 — clock skew: far-future / far-past capturedAt
// ═══════════════════════════════════════════════════════════════════════════

Deno.test({
  name:
    "S3 REPRO(P3): capturedAt 2999-01-01 / 1900-01-01 accepted; progress_daily reports both days; the future row pins rn=1 (weight 8) in the form-weighted rank forever",
  ignore,
  async fn() {
    // Expected (fixed): a CHECK / RPC guard bounding captured_at to
    // [launch, now() + skew] — or the views excluding rows outside it — so a
    // skewed device clock cannot create a permanent "newest" sample.
    const sql = connect();
    try {
      await withAlice(sql, async (tx) => {
        const future = shotPayload({
          analysisPermitId: await reserve(tx, "s3f"),
          capturedAt: "2999-01-01T00:00:00Z",
          overallScore: 9.5,
        });
        const past = shotPayload({
          analysisPermitId: await reserve(tx, "s3p"),
          capturedAt: "1900-01-01T00:00:00Z",
          overallScore: 1.5,
        });
        assertEquals(await apply(tx, future), "accepted");
        assertEquals(await apply(tx, past), "accepted");
        const days = await tx.unsafe(
          `select day::text as day, avg_score::text as avg from public.progress_daily where user_id = '${ALICE}' order by day`,
        );
        assertEquals(days.map((r) => r.day), ["1900-01-01", "2999-01-01"]);
        // Eight later, genuinely recent shots cannot dislodge the 2999 row from rn=1.
        for (let i = 0; i < 8; i++) {
          const p = await reserve(tx, `s3n${i}`);
          assertEquals(
            await apply(
              tx,
              shotPayload({
                analysisPermitId: p,
                capturedAt: `2026-09-0${(i % 8) + 1}T12:00:00Z`,
                overallScore: 2,
              }),
            ),
            "accepted",
          );
        }
        const tech = await tx.unsafe(
          `select score::float8 as score, captured_at::text as captured_at, sampled_count from public.player_technique_rating where user_id = '${ALICE}'`,
        );
        assertEquals(tech.length, 1);
        assertEquals(tech[0].sampled_count, 8);
        assertStringIncludes(tech[0].captured_at, "2999-01-01");
        // Weighted: 9.5×8 + 2×(7+6+5+4+3+2+1)=28 → (7600+5600)/36 = 366.67 → 3.67
        assertEquals(
          tech[0].score,
          3.67,
          "future row carries weight 8 in the 8-sample window",
        );
        const rank = await tx.unsafe(
          `select rating::text as r from public.player_rank_state where user_id = '${ALICE}'`,
        );
        assertEquals(rank[0].r, "3.67");
        log(
          "S3",
          "BROKEN",
          `2999/1900 accepted; progress_daily days=${
            days.map((r) => r.day).join(",")
          }; technique captured_at=2999, score=3.67 with 2999 row at weight 8 vs 2.00 honest form`,
        );
      }, { premium: true });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "S3 REPRO(P3): capturedAt 'infinity' (direct RPC only) is accepted → progress_daily day = infinity",
  ignore,
  async fn() {
    // Expected (fixed): finite-timestamp CHECK on shots.captured_at.
    const sql = connect();
    try {
      await withAlice(sql, async (tx) => {
        const p = await reserve(tx, "s3i");
        const payload = shotPayload({
          analysisPermitId: p,
          capturedAt: "infinity",
        });
        // The edge parser rejects this (Date.parse → NaN) — direct RPC path only.
        assert(Number.isNaN(Date.parse("infinity")));
        assertEquals(await apply(tx, payload), "accepted");
        const days = await tx.unsafe(
          `select day::text as day from public.progress_daily where user_id = '${ALICE}'`,
        );
        assertEquals(days[0].day, "infinity");
        log(
          "S3",
          "BROKEN",
          "capturedAt=infinity accepted via direct RPC; progress_daily.day='infinity' (edge parser blocks it; P3 defense-in-depth)",
        );
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "S3 HELD: practice_days is driven by captures (not shots) — a skewed shot never fabricates a practice day",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await withAlice(sql, async (tx) => {
        const p = await reserve(tx, "s3pd");
        assertEquals(
          await apply(
            tx,
            shotPayload({
              analysisPermitId: p,
              capturedAt: "2999-01-01T00:00:00Z",
            }),
          ),
          "accepted",
        );
        assertEquals(
          await count(tx, "public.practice_days", `user_id = '${ALICE}'`),
          0,
        );
        log(
          "S3",
          "HELD",
          "practice_days unaffected by shot sync (view reads public.captures)",
        );
      });
    } finally {
      await sql.end();
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// S4 — time ordering
// ═══════════════════════════════════════════════════════════════════════════

Deno.test({
  name:
    "S4 REPRO(P3): startMs=500 > contactMs=100 > endMs=50 (and negative ms) accepted — no ordering CHECK; rank consumers tolerate the row; no server-side phase consumer exists",
  ignore,
  async fn() {
    // Expected (fixed): CHECK (start_ms <= end_ms and (contact_ms is null or
    // contact_ms between start_ms and end_ms)) on shots and the analogous
    // start_ms <= representative_ms <= end_ms on shot_phases, plus >= 0.
    const sql = connect();
    try {
      await withAlice(sql, async (tx) => {
        const checks = await tx.unsafe(
          `select conname, pg_get_constraintdef(oid) as def from pg_constraint
           where conrelid in ('public.shots'::regclass, 'public.shot_phases'::regclass) and contype = 'c'`,
        );
        const ordering = checks.filter((c) =>
          /start_ms|end_ms|contact_ms|representative_ms/.test(String(c.def))
        );
        assertEquals(
          ordering.length,
          0,
          `unexpected ms CHECK present: ${JSON.stringify(ordering)}`,
        );

        const p1 = await reserve(tx, "s4a");
        const inverted = shotPayload({
          analysisPermitId: p1,
          startMs: 500,
          contactMs: 100,
          endMs: 50,
          phases: [{
            key: "contact",
            startMs: 900,
            representativeMs: 500,
            endMs: 100,
            confidence: 0.5,
          }],
        });
        assertEquals(await apply(tx, inverted), "accepted");
        const row = await tx.unsafe(
          `select start_ms, contact_ms, end_ms from public.shots where id = '${inverted.id}'`,
        );
        assertEquals({ ...row[0] }, {
          start_ms: 500,
          contact_ms: 100,
          end_ms: 50,
        });
        const ph = await tx.unsafe(
          `select start_ms, representative_ms, end_ms from public.shot_phases where shot_id = '${inverted.id}'`,
        );
        assertEquals({ ...ph[0] }, {
          start_ms: 900,
          representative_ms: 500,
          end_ms: 100,
        });

        const p2 = await reserve(tx, "s4b");
        const negative = shotPayload({
          analysisPermitId: p2,
          startMs: -5,
          contactMs: -1,
          endMs: -100,
        });
        assertEquals(await apply(tx, negative), "accepted");

        // Rank/progress consumers never read the ms columns → tolerate the rows.
        const rank = await tx.unsafe(
          `select scored_shot_count as c, rating::text as r from public.player_rank_state where user_id = '${ALICE}'`,
        );
        assertEquals(rank[0].c, 2);
        assertEquals(rank[0].r, "7.00");
        assertEquals(
          await count(tx, "public.progress_daily", `user_id = '${ALICE}'`),
          1,
        );
        log(
          "S4",
          "BROKEN",
          "inverted (500/100/50) and negative ms accepted, no CHECK; rank=7.00 count=2 (consumers tolerate); edge parser blocks negatives but NOT inversion",
        );
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "S4 static pin: parseSyncShot enforces isMs (>=0, <=2^31-1) per field but has no start<=contact<=end ordering rule",
  ignore,
  async fn() {
    const edge = await Deno.readTextFile(EDGE_INDEX);
    const body = edge.slice(
      edge.indexOf("function parseSyncShot"),
      edge.indexOf("const rankCacheKey"),
    );
    assertStringIncludes(body, "!isMs(ts.startMs)");
    assertStringIncludes(body, "!isMs(ts.endMs)");
    assert(
      !/startMs\s*(<=|<|>|>=)\s*(ts\.)?(endMs|contactMs)/.test(body),
      "ordering rule unexpectedly present",
    );
    assert(
      !/endMs\s*(<=|<|>|>=)\s*(ts\.)?startMs/.test(body),
      "ordering rule unexpectedly present",
    );
    log(
      "S4",
      "BROKEN",
      "edge parser has no timestamp ordering rule either (static)",
    );
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// S5 — huge detail arrays and mid-loop failure
// ═══════════════════════════════════════════════════════════════════════════

Deno.test({
  name:
    "S5 REPRO(P2): apply_synced_shot has no cardinality cap — 10,000 phases / ~400 KiB of checkpoints are stored in one call (edge caps 32/64 are bypassable)",
  ignore,
  async fn() {
    // Expected (fixed): the RPC rejects jsonb_array_length(phases) > 32 or
    // jsonb_array_length(checkpoints) > 64 (mirroring parseSyncShot) so the
    // per-shot storage/statement cost is bounded at the security boundary.
    const sql = connect();
    try {
      await withAlice(sql, async (tx) => {
        const p1 = await reserve(tx, "s5a");
        const phases = Array.from({ length: 10_000 }, (_, i) => ({
          key: `p${i}`,
          startMs: i,
          representativeMs: i,
          endMs: i + 1,
          confidence: Math.round(rand() * 10_000) / 10_000,
        }));
        const big = shotPayload({ analysisPermitId: p1, phases });
        let t0 = performance.now();
        assertEquals(await apply(tx, big), "accepted");
        const phasesMs = Math.round(performance.now() - t0);
        assertEquals(
          await count(tx, "public.shot_phases", `shot_id = '${big.id}'`),
          10_000,
        );

        const p2 = await reserve(tx, "s5b");
        const checkpoints = Array.from({ length: 2200 }, (_, i) => ({
          key: `c${i}`,
          score: 50,
          confidence: 0.5,
          band: "green",
          direction: "d".repeat(64),
          severity: 0.5,
          applicable: true,
        }));
        const bytes =
          new TextEncoder().encode(JSON.stringify(checkpoints)).byteLength;
        assert(bytes >= 300 * 1024, `checkpoints payload ${bytes} B`);
        const bigCp = shotPayload({ analysisPermitId: p2, checkpoints });
        t0 = performance.now();
        assertEquals(await apply(tx, bigCp), "accepted");
        const cpMs = Math.round(performance.now() - t0);
        assertEquals(
          await count(tx, "public.shot_checkpoints", `shot_id = '${bigCp.id}'`),
          2200,
        );
        log(
          "S5",
          "BROKEN",
          `10000 phases stored in ${phasesMs} ms; ${bytes} B checkpoints (2200 rows) stored in ${cpMs} ms; no cap in RPC (edge caps 32/64 only)`,
        );
      }, { premium: true });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "S5 HELD: mid-loop failure (65-char key at entry 5000; bad numeric at checkpoint 3000) leaves zero shot/detail rows and the permit reserved",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await withAlice(sql, async (tx) => {
        const permit = await reserve(tx, "s5c");
        const phases = Array.from({ length: 6000 }, (_, i) => ({
          key: i === 4999 ? "k".repeat(65) : `p${i}`,
          startMs: i,
          representativeMs: i,
          endMs: i + 1,
          confidence: 0.5,
        }));
        const a = shotPayload({ analysisPermitId: permit, phases });
        const sa = await apply(tx, a);
        assertStringIncludes(sa, "shot.write_failed:");
        assertStringIncludes(sa, "shot_detail_key_bounds");
        assertEquals(await count(tx, "public.shots", `id = '${a.id}'`), 0);
        assertEquals(
          await count(tx, "public.shot_phases", `shot_id = '${a.id}'`),
          0,
        );
        assertEquals((await permitState(tx, permit)).status, "reserved");

        const checkpoints = Array.from({ length: 4000 }, (_, i) => ({
          key: `c${i}`,
          score: i === 2999 ? "NaNx" : 50,
          confidence: 0.5,
          band: "green",
          direction: "d",
          severity: 0.5,
          applicable: true,
        }));
        const b = shotPayload({
          analysisPermitId: permit,
          checkpoints,
          phases: [{
            key: "contact",
            startMs: 0,
            representativeMs: 1,
            endMs: 2,
            confidence: 0.5,
          }],
        });
        const sb = await apply(tx, b);
        assertStringIncludes(
          sb,
          "shot.write_failed:invalid input syntax for type numeric",
        );
        assertEquals(await count(tx, "public.shots", `id = '${b.id}'`), 0);
        assertEquals(
          await count(tx, "public.shot_phases", `shot_id = '${b.id}'`),
          0,
        );
        assertEquals(
          await count(tx, "public.shot_checkpoints", `shot_id = '${b.id}'`),
          0,
        );
        assertEquals((await permitState(tx, permit)).status, "reserved");
        const ledger = await tx.unsafe(
          `select public.lifetime_scored_count() as n`,
        );
        assertEquals(ledger[0].n, 0);
        log(
          "S5",
          "HELD",
          "mid-loop failures atomic: 0 shot rows, 0 detail rows, permit reserved, ledger 0",
        );
      });
    } finally {
      await sql.end();
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// S6 — duplicate detail keys
// ═══════════════════════════════════════════════════════════════════════════

Deno.test({
  name:
    "S6 HELD: duplicate phase/checkpoint keys → first entry wins (ON CONFLICT DO NOTHING), later duplicates silently dropped, status accepted",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await withAlice(sql, async (tx) => {
        const permit = await reserve(tx, "s6");
        const c1 = Math.round(rand() * 1000) / 10_000; // 0..0.1
        const c2 = 0.9 + Math.round(rand() * 999) / 10_000; // 0.9..1
        const payload = shotPayload({
          analysisPermitId: permit,
          phases: [
            {
              key: "contact",
              startMs: 0,
              representativeMs: 1,
              endMs: 2,
              confidence: c1,
            },
            {
              key: "contact",
              startMs: 10,
              representativeMs: 11,
              endMs: 12,
              confidence: c2,
            },
            {
              key: "contact",
              startMs: 20,
              representativeMs: 21,
              endMs: 22,
              confidence: 0.5,
            },
          ],
          checkpoints: [
            {
              key: "cp",
              score: 10,
              confidence: 0.1,
              band: "red",
              direction: "x",
              severity: 0.1,
              applicable: true,
            },
            {
              key: "cp",
              score: 90,
              confidence: 0.9,
              band: "green",
              direction: "y",
              severity: 0.9,
              applicable: false,
            },
          ],
        });
        assertEquals(await apply(tx, payload), "accepted");
        const ph = await tx.unsafe(
          `select phase_key, start_ms, confidence::float8 as c from public.shot_phases where shot_id = '${payload.id}'`,
        );
        assertEquals(ph.length, 1);
        assertEquals(ph[0].start_ms, 0);
        assertEquals(ph[0].c, c1, "first-wins on phases");
        const cp = await tx.unsafe(
          `select score::float8 as s, band from public.shot_checkpoints where shot_id = '${payload.id}'`,
        );
        assertEquals(cp.length, 1);
        assertEquals(
          { ...cp[0] },
          { s: 10, band: "red" },
          "first-wins on checkpoints",
        );
        // Intent evidence: the edge rejects duplicates outright (shot.invalid_payload)
        // and defense_in_depth documents the details as write-once evidence with
        // no UPDATE privilege — DO NOTHING is the only conflict action that can
        // run under that grant, so first-wins is a consequence of write-once
        // semantics, not an explicit first-vs-last choice.
        const edge = await Deno.readTextFile(EDGE_INDEX);
        assertStringIncludes(edge, "Duplicate phase key:");
        assertStringIncludes(edge, "Duplicate checkpoint key:");
        const grants = await tx.unsafe(
          `select privilege_type from information_schema.role_table_grants
           where grantee = 'authenticated' and table_schema = 'public' and table_name = 'shot_phases'`,
        );
        assert(
          !grants.some((g) => g.privilege_type === "UPDATE"),
          "authenticated must not hold UPDATE on shot_phases",
        );
        log(
          "S6",
          "HELD",
          `first-wins: phase confidence=${c1} (dropped ${c2}, 0.5); checkpoint score=10/red; edge rejects duplicates upstream; no UPDATE grant → DO NOTHING is the only possible conflict action (write-once by design)`,
        );
      });
    } finally {
      await sql.end();
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// S7 — foreign session id
// ═══════════════════════════════════════════════════════════════════════════

Deno.test({
  name:
    "S7 HELD: sessionId owned by another user (and a nonexistent one) → shot.session_not_found, zero rows, permit reserved",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await withAlice(sql, async (tx) => {
        const permit = await reserve(tx, "s7");
        // Bob's session is invisible under RLS.
        assertEquals(
          await count(tx, "public.sessions", `id = '${BOB_SESSION}'`),
          0,
          "RLS must hide Bob's session",
        );
        const foreign = shotPayload({
          analysisPermitId: permit,
          sessionId: BOB_SESSION,
        });
        assertEquals(await apply(tx, foreign), "shot.session_not_found");
        assertEquals(
          await count(tx, "public.shots", `id = '${foreign.id}'`),
          0,
        );
        assertEquals(await permitState(tx, permit), {
          status: "reserved",
          outcome: null,
        });
        const ghost = shotPayload({
          analysisPermitId: permit,
          sessionId: seededUuid(),
        });
        assertEquals(await apply(tx, ghost), "shot.session_not_found");
        assertEquals(await permitState(tx, permit), {
          status: "reserved",
          outcome: null,
        });
        // Once the caller owns a session, the same permit still works.
        const mine = seededUuid();
        await tx.unsafe(
          `insert into public.sessions (id, user_id, started_at) values ('${mine}', '${ALICE}', now())`,
        );
        assertEquals(
          await apply(
            tx,
            shotPayload({ analysisPermitId: permit, sessionId: mine }),
          ),
          "accepted",
        );
        assertEquals((await permitState(tx, permit)).status, "finalized");
        log(
          "S7",
          "HELD",
          "foreign & ghost sessionId → shot.session_not_found, permit reserved, later valid sync consumes it",
        );
      });
    } finally {
      await sql.end();
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// S8 — concurrent syncs of the SAME shot id with two permits
// ═══════════════════════════════════════════════════════════════════════════

/** Committed-state concurrency: two connections, two open transactions.
 * A calls the RPC and HOLDS its transaction (advisory lock + uncommitted row);
 * B calls the RPC with the other permit and must block on the advisory lock
 * (asserted via pg_stat_activity); then A commits and B's outcome is
 * observed. `legacyScored` rows are inserted by the table owner (simulating
 * a scored shot written by a pre-reserve_analysis_permit build) AFTER both
 * permits were minted — reserve_analysis_permit itself would refuse a free
 * user a second permit once used+reserved reaches 2. Cleanup deletes the
 * user (cascades) and the ledger rows the definer trigger wrote. */
async function concurrentSameShot(
  opts: { premium: boolean; legacyScored: number },
): Promise<
  {
    a: string;
    b: string;
    rows: number;
    winnerScore: string | undefined;
    p1: { status: string; outcome: string | null };
    p2: { status: string; outcome: string | null };
    ledger: number;
  }
> {
  const user = seededUuid();
  const admin = connect();
  const connA = connect();
  const connB = connect();
  try {
    await seedUser(admin, user, {
      premium: opts.premium,
      providerId: `sub-${user}`,
    });
    const prep = async (tx: Sql, key: string) => {
      await asUser(tx, user);
      return await reserve(tx, key);
    };
    let p1 = "";
    let p2 = "";
    await admin.begin(async (tx) => {
      p1 = await prep(tx as unknown as Sql, "race1");
    });
    await admin.begin(async (tx) => {
      p2 = await prep(tx as unknown as Sql, "race2");
    });
    for (let i = 0; i < opts.legacyScored; i++) {
      await admin.unsafe(
        `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
           overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
           paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
         values ('${seededUuid()}', '${user}', 'dink', 'side', '2026-08-0${
          i + 1
        }T10:00:00Z', 0, 100, 200,
           5, 0.9, 'scored', '1', '1', '1', '1', '1', '1', '1', '1', 'real')`,
      );
    }

    const shotId = seededUuid();
    let statusA = "";
    let statusB = "";
    let aApplied!: () => void;
    const aAppliedP = new Promise<void>((r) => (aApplied = r));

    const txA = connA.begin(async (tx) => {
      const t = tx as unknown as Sql;
      await asUser(t, user);
      statusA = await apply(
        t,
        shotPayload({ id: shotId, analysisPermitId: p1, overallScore: 6 }),
      );
      aApplied();
      // Hold A open until B is provably blocked on the advisory lock.
      let blocked = false;
      for (let i = 0; i < 400 && !blocked; i++) {
        const waiting = await admin.unsafe(
          `select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and wait_event = 'advisory' and state = 'active'`,
        );
        blocked = (waiting[0].n as number) >= 1;
        if (!blocked) await new Promise((r) => setTimeout(r, 25));
      }
      assert(blocked, "B never blocked on the per-user advisory lock");
    });
    const txB = connB.begin(async (tx) => {
      const t = tx as unknown as Sql;
      await asUser(t, user);
      await aAppliedP;
      statusB = await apply(
        t,
        shotPayload({ id: shotId, analysisPermitId: p2, overallScore: 9 }),
      );
    });
    await Promise.all([txA, txB]);

    const rows = (await admin.unsafe(
      `select count(*)::int as n from public.shots where id = '${shotId}'`,
    ))[0].n as number;
    const winnerScore = (await admin.unsafe(
      `select overall_score::text as s from public.shots where id = '${shotId}'`,
    ))[0]?.s as string | undefined;
    const st1 = await permitState(admin, p1);
    const st2 = await permitState(admin, p2);
    const ledger = (await admin.unsafe(
      `select coalesce(max(scored_count), 0)::int as n from public.free_rating_ledger
       where identity_hash = public.free_rating_identity_hash('google', 'sub-${user}')`,
    ))[0].n as number;
    return {
      a: statusA,
      b: statusB,
      rows,
      winnerScore,
      p1: st1,
      p2: st2,
      ledger,
    };
  } finally {
    try {
      await admin.unsafe(`delete from auth.users where id = '${user}'`);
      await admin.unsafe(
        `delete from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', 'sub-${user}')`,
      );
    } finally {
      await Promise.all([admin.end(), connA.end(), connB.end()]);
    }
  }
}

Deno.test({
  name:
    "S8 HELD: two concurrent syncs of the same shot id with two permits → one row, both accepted, exactly one permit consumed (loser stays reserved)",
  ignore,
  async fn() {
    const r = await concurrentSameShot({ premium: true, legacyScored: 0 });
    assertEquals(r.rows, 1);
    assertEquals(
      r.winnerScore,
      "6.00",
      "A's row (the lock holder) must be the one stored",
    );
    assertEquals(r.a, "accepted");
    assertEquals(r.b, "accepted");
    assertEquals(r.p1, { status: "finalized", outcome: "scored" });
    assertEquals(
      r.p2,
      { status: "reserved", outcome: null },
      "second permit must not be consumed",
    );
    assertEquals(r.ledger, 1);
    log(
      "S8",
      "HELD",
      `premium: A=${r.a} B=${r.b} rows=${r.rows} p1=${r.p1.status}/${r.p1.outcome} p2=${r.p2.status}/${r.p2.outcome} ledger=${r.ledger}`,
    );
  },
});

Deno.test({
  name:
    "S8 REPRO(P3): same race for a FREE user whose identity already holds 1 legacy scored rating — the loser returns access.paywall_required and its permit is released as free_limit_exceeded although the shot is stored",
  ignore,
  async fn() {
    // Expected (fixed): after taking the advisory lock the RPC re-checks
    // ownership of the shot id (the pre-lock replay check is stale by then)
    // so B returns `accepted` and permit 2 is left reserved, as in the
    // premium case. Self-heals: the client's next replay hits the pre-lock
    // check and gets accepted; harm is a misleading paywall verdict and a
    // permit outcome that misreports the free limit. Reachable only with an
    // over-issued permit (legacy builds) — reserve_analysis_permit itself
    // refuses the second permit once used+reserved reaches 2.
    const r = await concurrentSameShot({ premium: false, legacyScored: 1 });
    assertEquals(r.rows, 1);
    assertEquals(r.winnerScore, "6.00");
    assertEquals(r.a, "accepted");
    assertEquals(r.b, "access.paywall_required");
    assertEquals(r.p1, { status: "finalized", outcome: "scored" });
    assertEquals(r.p2, { status: "released", outcome: "free_limit_exceeded" });
    assertEquals(r.ledger, 2);
    log(
      "S8",
      "BROKEN",
      `free@1: A=${r.a} B=${r.b} rows=${r.rows} p2=${r.p2.status}/${r.p2.outcome} (stale pre-lock replay check)`,
    );
  },
});

Deno.test({
  name:
    "S8 HELD: free user with 0 prior ratings — race resolves like premium (both accepted, one permit)",
  ignore,
  async fn() {
    const r = await concurrentSameShot({ premium: false, legacyScored: 0 });
    assertEquals(r.rows, 1);
    assertEquals(r.winnerScore, "6.00");
    assertEquals([r.a, r.b], ["accepted", "accepted"]);
    assertEquals(r.p1.status, "finalized");
    assertEquals(r.p2, { status: "reserved", outcome: null });
    assertEquals(r.ledger, 1);
    log(
      "S8",
      "HELD",
      `free@0: A=${r.a} B=${r.b} rows=${r.rows} p2=${r.p2.status}`,
    );
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// S9 — identity hash sensitivity
// ═══════════════════════════════════════════════════════════════════════════

Deno.test({
  name:
    "S9 HELD: free_rating_identity_hash is byte-exact — case / whitespace / provider-case variants hash differently (no normalisation in SQL)",
  ignore,
  async fn() {
    const sql = connect();
    try {
      const h = async (provider: string, id: string) =>
        (await sql.unsafe(
          `select public.free_rating_identity_hash($1, $2) as h`,
          [provider, id],
        ))[0].h as string;
      const base = await h("google", "google-sub");
      const variants: Array<[string, string]> = [
        ["google", "Google-Sub"],
        ["google", "google-sub "],
        ["google", " google-sub"],
        ["google", "google-sub\u200b"],
        ["google", "google\u2010sub"],
        ["Google", "google-sub"],
        ["apple", "google-sub"],
      ];
      for (const [p, id] of variants) {
        assertNotEquals(await h(p, id), base, `${p}:${JSON.stringify(id)}`);
      }
      // NFC vs NFD of the same visible string also differ (no unicode normalisation).
      assertNotEquals(await h("google", "é"), await h("google", "e\u0301"));
      // Separator ambiguity: 'provider:id' concatenation collides when the
      // provider itself contains ':' — GoTrue providers are a fixed lowercase
      // ascii set, so this is not reachable from auth.identities.
      assertEquals(await h("google", "a:b"), await h("google:a", "b"));
      assertEquals(
        base,
        (await sql.unsafe(
          `select encode(sha256(convert_to('google:google-sub','UTF8')),'hex') as h`,
        ))[0].h,
      );
      const expectedProviders = (await sql.unsafe(
        `select pg_get_functiondef('public.free_rating_identity_hash(text,text)'::regprocedure) as d`,
      ))[0].d as string;
      assert(
        !/lower\(|trim\(|normalize\(/i.test(expectedProviders),
        "hash function must not normalise",
      );
      log(
        "S9",
        "HELD",
        "hash('Google-Sub') ≠ hash('google-sub'); whitespace/zero-width/hyphen/NFD variants all differ; provider case differs; GoTrue normalisation of provider_id: UNKNOWN (not observed here)",
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "S9 HELD: the ledger trigger hashes auth.identities.provider_id verbatim — two identities differing only by case are two separate free-rating ledgers",
  ignore,
  async fn() {
    const sql = connect();
    try {
      await withRollback(sql, async (tx) => {
        const u1 = seededUuid();
        const u2 = seededUuid();
        await seedUser(tx, u1, {
          provider: "google",
          providerId: "Google-Sub",
        });
        await seedUser(tx, u2, {
          provider: "google",
          providerId: "google-sub",
        });
        await asUser(tx, u1);
        assertEquals(
          await apply(
            tx,
            shotPayload({ analysisPermitId: await reserve(tx, "u1a") }),
          ),
          "accepted",
        );
        assertEquals(
          await apply(
            tx,
            shotPayload({ analysisPermitId: await reserve(tx, "u1b") }),
          ),
          "accepted",
        );
        const rows = await tx.unsafe(
          `select result from public.reserve_analysis_permit('u1c')`,
        );
        assertEquals(rows[0].result, "access.paywall_required");
        // u2 with the case-variant subject starts fresh: it is a different identity.
        await tx.unsafe(`reset role`);
        await asUser(tx, u2);
        const c = await tx.unsafe(`select public.lifetime_scored_count() as n`);
        assertEquals(c[0].n, 0);
        assertEquals(
          (await tx.unsafe(
            `select result from public.reserve_analysis_permit('u2a')`,
          ))[0].result,
          "accepted",
        );
        log(
          "S9",
          "HELD",
          "identity 'Google-Sub' exhausted (2/2) while 'google-sub' still has 0 used — exact-byte ledgers (an upstream normalisation question, UNKNOWN)",
        );
      });
    } finally {
      await sql.end();
    }
  },
});
