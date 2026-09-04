/**
 * stress: POST /v1/me/delete-request — DIRECT Postgres half (fuzz-boundary).
 *
 * The in-process campaign (stress_delete_request_fuzz.test.ts) proves the
 * handler over a stubbed PostgREST. This file drives the exact SQL shapes the
 * route emits — the `account_deletion_requests` re-arm upsert
 * (`on_conflict=user_id`, `resolution=merge-duplicates` ⇒ INSERT … ON
 * CONFLICT (user_id) DO UPDATE SET every payload column), the
 * `account_deletion_feedback` insert with the edge-sanitized survey columns,
 * and the `access_state()` RPC — on a disposable postgres:16 with
 * shim_auth.sql + every migration applied (./xc_pg_up.sh), as role
 * `authenticated` under RLS with the caller's JWT sub.
 *
 *   XC_PG_CONTAINER=pickle-stress-pg XC_PG_PORT=55434 ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55434/postgres \
 *     STRESS_PG_ITER=500 deno test -A --no-check --config deno.json stress_delete_request_pg.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) the test is `ignore`d — an
 * ignored run is NOT a pass. Seeded (STRESS_SEED): every user id and survey
 * value replays from the printed seed. Results:
 * artifacts/stress-delete-request/pg/pg_results.json (+ pg_summary.json).
 *
 * Per seeded user the campaign asserts:
 *   - two re-arm upserts leave exactly ONE row, challenge rotated, expires_at
 *     ≈ 15 min after created_at;
 *   - an upsert naming ANOTHER user's id is refused (42501) and writes nothing;
 *   - a feedback insert with edge-shaped values (reason/wanted vocab, details
 *     ≤ 500 chars incl. multi-byte, app_version ≤ 64, nullable stamps)
 *     round-trips exactly (Postgres length() is in characters, like the edge
 *     cap);
 *   - over-bound values the edge would never send (details 1001, app_version
 *     65, reason 51, wanted 51, negative counters) are refused by the CHECK
 *     constraints (23514), feedback for another user by RLS (42501), and any
 *     UPDATE/DELETE of feedback by the grant/append-only trigger (42501);
 *   - access_state() answers one row {premium boolean, scored_count ≥ 0};
 *   - another user sees zero deletion-request rows.
 */
import postgres from "postgres";
import { assertEquals } from "@std/assert";
import { envInt, Prng } from "./xc_concurrency_harness.ts";
import {
  iterationSeed,
  STRESS_SEED,
  writeJson,
} from "./stress_delete_request_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const STRESS_PG_ITER = envInt("STRESS_PG_ITER", 25);
const REPLAY = (Deno.env.get("STRESS_REPLAY") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map(Number)
  .filter((n) => Number.isFinite(n) && n >= 0);

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const REASONS = [
  "not_using",
  "not_helpful",
  "scores_inaccurate",
  "technical_issues",
  "too_expensive",
  "privacy",
  "other",
];
const WANTED = [
  "accuracy",
  "price",
  "content",
  "stability",
  "switched",
  "nothing",
];
const PLATFORMS = ["ios", "android"];

interface OpRow {
  seed: number;
  user: string;
  op: string;
  expected: string;
  observed: string;
  detail: Record<string, unknown>;
  ms: number;
  violations: string[];
  ok: boolean;
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
}

/** Characters the edge sanitizer lets through: printable ASCII, accented
 * Latin, CJK, emoji (astral → 2 UTF-16 units but ONE Postgres char). */
const ALPHABET = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:!?'\"()-_/",
  "é",
  "ü",
  "ñ",
  "ß",
  "日",
  "本",
  "語",
  "한",
  "😀",
  "🏓",
  "é",
  "\u200d",
];

function text(prng: Prng, chars: number): string {
  let out = "";
  for (let i = 0; i < chars; i++) {
    out += ALPHABET[prng.int(0, ALPHABET.length - 1)];
  }
  return out;
}

function pgChars(s: string): number {
  return [...s].length;
}

interface Survey {
  reason: string;
  wanted: string | null;
  details: string | null;
  platform: string | null;
  app_version: string | null;
  account_age_days: number | null;
  was_premium: boolean | null;
  scored_count: number | null;
}

function edgeShapedSurvey(prng: Prng): Survey {
  const detailLens = [0, 1, 2, 17, 128, 255, 256, 499, 500];
  const versionLens = [1, 5, 11, 63, 64];
  const detailsLen = detailLens[prng.int(0, detailLens.length - 1)];
  return {
    reason: REASONS[prng.int(0, REASONS.length - 1)],
    wanted: prng.next() < 0.3 ? null : WANTED[prng.int(0, WANTED.length - 1)],
    details: prng.next() < 0.2 ? null : text(prng, detailsLen),
    platform: prng.next() < 0.2
      ? null
      : PLATFORMS[prng.int(0, PLATFORMS.length - 1)],
    app_version: prng.next() < 0.2
      ? null
      : text(prng, versionLens[prng.int(0, versionLens.length - 1)]),
    account_age_days: prng.next() < 0.3 ? null : prng.int(0, 5_000),
    was_premium: prng.next() < 0.3 ? null : prng.next() < 0.5,
    scored_count: prng.next() < 0.3 ? null : prng.int(0, 100_000),
  };
}

type Bad = { name: string; mutate: (s: Survey) => void; code: string };
const OVER_BOUND: Bad[] = [
  {
    name: "details_1001",
    mutate: (s) => (s.details = "x".repeat(1001)),
    code: "23514",
  },
  {
    name: "details_1001_multibyte",
    mutate: (s) => (s.details = "日".repeat(1001)),
    code: "23514",
  },
  {
    name: "app_version_65",
    mutate: (s) => (s.app_version = "v".repeat(65)),
    code: "23514",
  },
  {
    name: "reason_51",
    mutate: (s) => (s.reason = "r".repeat(51)),
    code: "23514",
  },
  {
    name: "wanted_51",
    mutate: (s) => (s.wanted = "w".repeat(51)),
    code: "23514",
  },
  {
    name: "platform_21",
    mutate: (s) => (s.platform = "p".repeat(21)),
    code: "23514",
  },
  { name: "provider_51", mutate: () => {}, code: "23514" },
  {
    name: "account_age_negative",
    mutate: (s) => (s.account_age_days = -1),
    code: "23514",
  },
  {
    name: "scored_count_negative",
    mutate: (s) => (s.scored_count = -1),
    code: "23514",
  },
];

function insertFeedbackSql(
  userId: string,
  s: Survey,
  provider = "google",
): [string, unknown[]] {
  return [
    `insert into public.account_deletion_feedback
      (user_id, reason, wanted, details, provider, platform, app_version, account_age_days, was_premium, scored_count)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      userId,
      s.reason,
      s.wanted,
      s.details,
      provider,
      s.platform,
      s.app_version,
      s.account_age_days,
      s.was_premium,
      s.scored_count,
    ],
  ];
}

/** PostgREST's translation of `.upsert(row, { onConflict: "user_id" })`
 * (Prefer: resolution=merge-duplicates): every payload column in DO UPDATE. */
function upsertSql(): string {
  return `insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
    values ($1, $2, $3, $4)
    on conflict (user_id) do update set
      user_id = excluded.user_id, challenge = excluded.challenge,
      created_at = excluded.created_at, expires_at = excluded.expires_at`;
}

function pgCode(e: unknown): string {
  return typeof e === "object" && e !== null && "code" in e
    ? String((e as { code: unknown }).code)
    : String(e);
}

Deno.test({
  name:
    `stress delete-request pg: seeded RLS/constraint campaign (STRESS_PG_ITER=${STRESS_PG_ITER}, STRESS_SEED=${STRESS_SEED})`,
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    const rows: OpRow[] = [];
    const seeds = REPLAY.length > 0
      ? REPLAY
      : Array.from({ length: STRESS_PG_ITER }, (_, i) =>
        iterationSeed(STRESS_SEED ^ 0x7067, i));
    const t0 = performance.now();

    const record = async (
      seed: number,
      user: string,
      op: string,
      expected: string,
      run: () => Promise<
        {
          observed: string;
          detail?: Record<string, unknown>;
          violations?: string[];
        }
      >,
    ) => {
      const s = performance.now();
      let out: {
        observed: string;
        detail?: Record<string, unknown>;
        violations?: string[];
      };
      try {
        out = await run();
      } catch (e) {
        out = {
          observed: `throw:${pgCode(e)}`,
          detail: { message: String(e).slice(0, 200) },
        };
      }
      const violations = [...(out.violations ?? [])];
      if (out.observed !== expected) {
        violations.unshift(`observed ${out.observed} != expected ${expected}`);
      }
      rows.push({
        seed,
        user,
        op,
        expected,
        observed: out.observed,
        detail: out.detail ?? {},
        ms: Math.round((performance.now() - s) * 100) / 100,
        violations,
        ok: violations.length === 0,
      });
    };

    try {
      for (const seed of seeds) {
        const prng = new Prng(seed);
        const user = prng.uuid();
        const other = prng.uuid();
        await createUser(sql, user);
        await createUser(sql, other);

        // 1. re-arm upsert twice → one row, rotated challenge, 15-min window.
        await record(
          seed,
          user,
          "rearm_upsert_x2",
          "one_row_rotated",
          async () => {
            const c1 = prng.uuid();
            const c2 = prng.uuid();
            const runUpsert = (challenge: string) =>
              sql.begin(async (tx) => {
                const t = tx as unknown as Tx;
                await asUser(t, user);
                const now = new Date();
                const exp = new Date(now.getTime() + 15 * 60_000);
                await t.unsafe(upsertSql(), [
                  user,
                  challenge,
                  now.toISOString(),
                  exp.toISOString(),
                ]);
              });
            await runUpsert(c1);
            await runUpsert(c2);
            const got = await sql.unsafe(
              `select user_id, challenge::text, extract(epoch from (expires_at - created_at)) as window_s
               from public.account_deletion_requests where user_id = '${user}'`,
            );
            const total = await sql.unsafe(
              `select count(*)::int as n from public.account_deletion_requests where user_id = '${user}'`,
            );
            const v: string[] = [];
            if (total[0].n !== 1) v.push(`${total[0].n} rows for the user`);
            if (got[0]?.challenge !== c2) {
              v.push("challenge not rotated to the latest upsert");
            }
            if (Math.abs(Number(got[0]?.window_s) - 900) > 1) {
              v.push(`window ${got[0]?.window_s}s != 900s`);
            }
            return {
              observed: v.length ? "mismatch" : "one_row_rotated",
              detail: { rows: total[0].n },
              violations: v,
            };
          },
        );

        // 2. cross-user upsert refused by RLS, nothing written.
        await record(
          seed,
          user,
          "cross_user_upsert",
          "throw:42501",
          async () => {
            const before = await sql.unsafe(
              `select count(*)::int as n from public.account_deletion_requests where user_id = '${other}'`,
            );
            try {
              await sql.begin(async (tx) => {
                const t = tx as unknown as Tx;
                await asUser(t, user);
                await t.unsafe(upsertSql(), [
                  other,
                  prng.uuid(),
                  new Date().toISOString(),
                  new Date(Date.now() + 900_000).toISOString(),
                ]);
              });
              return { observed: "accepted" };
            } catch (e) {
              const after = await sql.unsafe(
                `select count(*)::int as n from public.account_deletion_requests where user_id = '${other}'`,
              );
              const v = after[0].n !== before[0].n
                ? ["a refused upsert changed the victim's row count"]
                : [];
              return { observed: `throw:${pgCode(e)}`, violations: v };
            }
          },
        );

        // 3. edge-shaped feedback insert round-trips exactly.
        const survey = edgeShapedSurvey(prng);
        await record(
          seed,
          user,
          "feedback_insert_edge_shaped",
          "roundtrip",
          async () => {
            // The client grant is INSERT-only, so — like PostgREST with
            // Prefer: return=minimal — no RETURNING; the owner reads it back.
            const [q, params] = insertFeedbackSql(user, survey);
            await sql.begin(async (tx) => {
              const t = tx as unknown as Tx;
              await asUser(t, user);
              await t.unsafe(q, params as never[]);
            });
            const back = await sql.unsafe(
              `select * from public.account_deletion_feedback where user_id = '${user}' order by created_at desc`,
            );
            const row = back[0] ?? {};
            const v: string[] = [];
            if (back.length !== 1) {
              v.push(`${back.length} feedback rows for the user`);
            }
            for (
              const k of [
                "reason",
                "wanted",
                "details",
                "platform",
                "app_version",
                "account_age_days",
                "was_premium",
                "scored_count",
              ] as const
            ) {
              if (row[k] !== survey[k]) v.push(`${k} did not round-trip`);
            }
            if (row.user_id !== user) v.push("user_id changed");
            if (row.provider !== "google") v.push("provider changed");
            return {
              observed: v.length ? "mismatch" : "roundtrip",
              detail: {
                detailsChars: survey.details ? pgChars(survey.details) : null,
                versionChars: survey.app_version
                  ? pgChars(survey.app_version)
                  : null,
              },
              violations: v,
            };
          },
        );

        // 4. over-bound / cross-user / mutation attempts are refused.
        const bad = OVER_BOUND[prng.int(0, OVER_BOUND.length - 1)];
        await record(
          seed,
          user,
          `feedback_refused:${bad.name}`,
          `throw:${bad.code}`,
          async () => {
            const s = edgeShapedSurvey(prng);
            bad.mutate(s);
            const provider = bad.name === "provider_51"
              ? "g".repeat(51)
              : "google";
            const before = await sql.unsafe(
              `select count(*)::int as n from public.account_deletion_feedback where user_id = '${user}'`,
            );
            try {
              const [q, params] = insertFeedbackSql(user, s, provider);
              await sql.begin(async (tx) => {
                const t = tx as unknown as Tx;
                await asUser(t, user);
                await t.unsafe(q, params as never[]);
              });
              return { observed: "accepted" };
            } catch (e) {
              const after = await sql.unsafe(
                `select count(*)::int as n from public.account_deletion_feedback where user_id = '${user}'`,
              );
              const v = after[0].n !== before[0].n
                ? ["a refused insert changed the row count"]
                : [];
              return { observed: `throw:${pgCode(e)}`, violations: v };
            }
          },
        );
        await record(
          seed,
          user,
          "feedback_for_other_user",
          "throw:42501",
          async () => {
            try {
              const [q, params] = insertFeedbackSql(
                other,
                edgeShapedSurvey(prng),
              );
              await sql.begin(async (tx) => {
                const t = tx as unknown as Tx;
                await asUser(t, user);
                await t.unsafe(q, params as never[]);
              });
              return { observed: "accepted" };
            } catch (e) {
              return { observed: `throw:${pgCode(e)}` };
            }
          },
        );
        const mutation = prng.next() < 0.5 ? "update" : "delete";
        await record(
          seed,
          user,
          `feedback_${mutation}_own`,
          "throw:42501",
          async () => {
            try {
              await sql.begin(async (tx) => {
                const t = tx as unknown as Tx;
                await asUser(t, user);
                await t.unsafe(
                  mutation === "update"
                    ? `update public.account_deletion_feedback set details = 'edited' where user_id = '${user}'`
                    : `delete from public.account_deletion_feedback where user_id = '${user}'`,
                );
              });
              const still = await sql.unsafe(
                `select count(*)::int as n from public.account_deletion_feedback where user_id = '${user}' and details is distinct from 'edited'`,
              );
              return {
                observed: "accepted",
                detail: { untouched: still[0].n },
              };
            } catch (e) {
              return { observed: `throw:${pgCode(e)}` };
            }
          },
        );

        // 5. access_state() as the user: one row, sane types.
        await record(seed, user, "access_state_rpc", "one_row", async () => {
          const r = await sql.begin(async (tx) => {
            const t = tx as unknown as Tx;
            await asUser(t, user);
            return await t.unsafe(
              `select premium, scored_count from public.access_state()`,
            );
          });
          const v: string[] = [];
          if (r.length !== 1) v.push(`${r.length} rows`);
          if (typeof r[0]?.premium !== "boolean") v.push("premium not boolean");
          if (!Number.isInteger(r[0]?.scored_count) || r[0].scored_count < 0) {
            v.push("scored_count not a non-negative integer");
          }
          return {
            observed: v.length ? "mismatch" : "one_row",
            detail: {
              premium: r[0]?.premium,
              scored_count: r[0]?.scored_count,
            },
            violations: v,
          };
        });

        // 6. isolation: the other user sees none of it.
        await record(
          seed,
          user,
          "other_user_sees_nothing",
          "zero_rows",
          async () => {
            const requests = await sql.begin(async (tx) => {
              const t = tx as unknown as Tx;
              await asUser(t, other);
              const a = await t.unsafe(
                `select count(*)::int as n from public.account_deletion_requests`,
              );
              return a[0].n as number;
            });
            let feedbackVisible: string;
            try {
              await sql.begin(async (tx) => {
                const t = tx as unknown as Tx;
                await asUser(t, other);
                await t.unsafe(
                  `select count(*) from public.account_deletion_feedback`,
                );
              });
              feedbackVisible = "select_allowed";
            } catch (e) {
              feedbackVisible = `throw:${pgCode(e)}`;
            }
            const r = { requests, feedbackVisible };
            const v: string[] = [];
            if (r.requests !== 0) {
              v.push(`other user sees ${r.requests} deletion request(s)`);
            }
            if (r.feedbackVisible !== "throw:42501") {
              v.push(`feedback readable by a client: ${r.feedbackVisible}`);
            }
            return {
              observed: v.length ? "mismatch" : "zero_rows",
              detail: r,
              violations: v,
            };
          },
        );
      }
    } finally {
      await sql.end({ timeout: 5 });
    }

    const failed = rows.filter((r) => !r.ok);
    const summary = {
      campaign: {
        seed: STRESS_SEED,
        users: seeds.length,
        ops: rows.length,
        replay: REPLAY.length ? REPLAY : null,
        elapsedMs: Math.round(performance.now() - t0),
      },
      opHistogram: rows.reduce<Record<string, number>>(
        (h, r) => ((h[r.op] = (h[r.op] ?? 0) + 1), h),
        {},
      ),
      observedHistogram: rows.reduce<Record<string, number>>(
        (
          h,
          r,
        ) => ((h[`${r.op} → ${r.observed}`] =
          (h[`${r.op} → ${r.observed}`] ?? 0) + 1),
          h),
        {},
      ),
      failures: failed.map((r) => ({
        seed: r.seed,
        op: r.op,
        expected: r.expected,
        observed: r.observed,
        violations: r.violations,
      })),
      replayCommand:
        `XC_PG_URL=<url> STRESS_REPLAY=<seed> deno test -A --no-check --config deno.json stress_delete_request_pg.test.ts`,
    };
    const table = await writeJson("pg_results.json", rows, "pg");
    const summaryPath = await writeJson("pg_summary.json", summary, "pg");
    console.log(
      `[stress-pg] ${rows.length} ops / ${seeds.length} users in ${summary.campaign.elapsedMs}ms → ${table}, ${summaryPath}`,
    );
    assertEquals(
      failed.length,
      0,
      `${failed.length} op(s) violated the contract; first: seed ${
        failed[0]?.seed
      } ${failed[0]?.op} → ${failed[0]?.violations.join(" | ")}`,
    );
  },
});
