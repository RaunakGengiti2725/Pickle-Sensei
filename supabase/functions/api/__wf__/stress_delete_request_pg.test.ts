/**
 * STRESS — POST /v1/me/delete-request, Postgres-backed half.
 *
 * The REAL edge handler runs in-process (stress_delete_request_harness.ts);
 * Supabase Auth stays stubbed, but every PostgREST call the route makes is
 * forwarded to a REAL PostgREST (postgrest/postgrest v12) in front of a
 * disposable postgres:16 with shim_auth.sql + every migration applied
 * (./stress_pg_postgrest_up.sh). The upsert, the access_state() RPC, the
 * profiles read and the exit-survey insert therefore hit the real RLS
 * policies, column grants, check constraints, FKs and triggers.
 *
 *   ./stress_pg_postgrest_up.sh                 # prints the three env vars
 *   STRESS_PG_URL=… STRESS_POSTGREST_URL=… STRESS_JWT_SECRET=… \
 *     STRESS_OUT_DIR=/tmp/stress deno test -A --no-check --config deno.json stress_delete_request_pg.test.ts
 *
 * Without the env every test is `ignore`d — an ignored run is NOT a pass.
 * Seeded (STRESS_SEED): user ids / survey shapes replay from the seed.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  drive,
  envInt,
  type Harness,
  latencyStats,
  loadStressHarness,
  type Outcome,
  Prng,
  STRESS_ITER,
  STRESS_SEED,
  VALID_SURVEY,
  writeReport,
} from "./stress_delete_request_harness.ts";

const PG_URL = Deno.env.get("STRESS_PG_URL") ?? "";
const PGRST_URL = Deno.env.get("STRESS_POSTGREST_URL") ?? "";
const JWT_SECRET = Deno.env.get("STRESS_JWT_SECRET") ?? "";
const ignore = PG_URL === "" || PGRST_URL === "" || JWT_SECRET === "";
const PG_LOAD_N = envInt("STRESS_PG_LOAD_N", 200);
const LANES = envInt("STRESS_PG_LANES", 16);
/** The route's own per-user budget (3 delete-requests / hour). */
const PER_USER_BUDGET = 3;

type Sql = ReturnType<typeof postgres>;

const h: Harness = await loadStressHarness();

let sql: Sql | null = null;

/** One pool per test (opened/closed inside the test body so Deno's resource
 * sanitizer is satisfied). */
async function withPg(fn: () => Promise<void>): Promise<void> {
  sql = postgres(PG_URL, { max: 8, onnotice: () => {} });
  h.restProxy = PGRST_URL;
  h.jwtSecret = JWT_SECRET;
  try {
    await fn();
  } finally {
    await sql.end({ timeout: 5 });
    sql = null;
    h.restProxy = null;
    h.jwtSecret = null;
  }
}

interface PgUser {
  id: string;
  token: string;
}

/** A real auth.users row (the migration trigger provisions public.profiles)
 * plus a stub session so the handler authenticates as that user. */
async function createUser(
  rng: Prng,
  opts: { provider?: "google" | "apple"; profile?: boolean } = {},
): Promise<PgUser> {
  const id = rng.uuid();
  const provider = opts.provider ?? "google";
  await sql!.unsafe(`delete from auth.users where id = '${id}'`);
  await sql!.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${id}', '${id}@example.com', '{"provider":"${provider}"}')`,
  );
  if (opts.profile === false) {
    await sql!.unsafe(`delete from public.profiles where id = '${id}'`);
  }
  h.registerUser({ id, provider });
  const token = h.mintSession(id);
  return { id, token };
}

async function deletionRows(userId: string) {
  return await sql!.unsafe(
    `select user_id::text, challenge::text, created_at, expires_at,
            extract(epoch from (expires_at - created_at))::float8 as ttl_seconds
       from public.account_deletion_requests where user_id = '${userId}'`,
  );
}

async function feedbackRows(userId: string) {
  return await sql!.unsafe(
    `select reason, wanted, details, provider, platform, app_version, account_age_days, was_premium, scored_count
       from public.account_deletion_feedback where user_id = '${userId}' order by created_at`,
  );
}

interface PgRow {
  id: string;
  title: string;
  seed: number;
  outcome: "HELD" | "BROKEN";
  status: number;
  supabaseRoundTrips: number;
  latencyMs: number;
  problems: string[];
  detail: unknown;
}

const rows: PgRow[] = [];

function record(
  id: string,
  title: string,
  seed: number,
  o: Outcome,
  problems: string[],
  detail: unknown,
) {
  rows.push({
    id,
    title,
    seed,
    outcome: problems.length === 0 ? "HELD" : "BROKEN",
    status: o.status,
    supabaseRoundTrips: o.supabaseRoundTrips,
    latencyMs: o.latencyMs,
    problems,
    detail,
  });
  return problems;
}

Deno.test({
  name: "STRESS delete-request (postgres:16 + real PostgREST): upsert, re-arm, survey, RLS, FK, concurrency",
  ignore,
  fn: () =>
    withPg(async () => {
      const rng = new Prng(STRESS_SEED + 70_000);
      const problemsAll: string[] = [];

      // PG1 — first request writes exactly one row whose challenge is the one
      // the client received, expiring 15 minutes after created_at.
      {
        h.calls = [];
        const u = await createUser(rng);
        const o = await drive(h, h.request({ token: u.token, body: {} }));
        const stored = await deletionRows(u.id);
        const challenge = (o.body as Record<string, unknown>)?.challenge;
        const problems: string[] = [];
        if (o.status !== 200) problems.push(`status ${o.status}: ${JSON.stringify(o.body)}`);
        if (stored.length !== 1) problems.push(`rows ${stored.length}`);
        if (stored[0]?.challenge !== challenge)
          problems.push("stored challenge differs from the response");
        if (Math.abs(Number(stored[0]?.ttl_seconds) - 900) > 5)
          problems.push(`ttl ${stored[0]?.ttl_seconds}s`);
        if (o.supabaseRoundTrips !== 2)
          problems.push(`round trips ${o.supabaseRoundTrips} (auth + upsert expected)`);
        problemsAll.push(
          ...record(
            "PG1",
            "first request → one row, challenge matches, 15 min ttl",
            STRESS_SEED + 70_000,
            o,
            problems,
            { stored },
          ).map((p) => `PG1: ${p}`),
        );
      }

      // PG2 — re-arming: the second request must REPLACE the row (upsert
      // merge-duplicates → DO UPDATE on every payload column; the column-level
      // UPDATE grant from 20260831160000_defense_in_depth.sql must cover them
      // all, otherwise 42501 → 503).
      {
        const u = await createUser(rng);
        const first = await drive(h, h.request({ token: u.token, body: {} }));
        await new Promise((r) => setTimeout(r, 20));
        const second = await drive(h, h.request({ token: u.token, body: {} }));
        const stored = await deletionRows(u.id);
        const c1 = (first.body as Record<string, unknown>)?.challenge;
        const c2 = (second.body as Record<string, unknown>)?.challenge;
        const problems: string[] = [];
        if (first.status !== 200 || second.status !== 200)
          problems.push(
            `statuses ${first.status}/${second.status}: ${JSON.stringify(second.body)}`,
          );
        if (stored.length !== 1) problems.push(`rows ${stored.length}`);
        if (c1 === c2) problems.push("challenge not rotated");
        if (stored[0]?.challenge !== c2) problems.push("row does not hold the latest challenge");
        problemsAll.push(
          ...record(
            "PG2",
            "second request re-arms: one row, latest challenge wins",
            STRESS_SEED + 70_001,
            second,
            problems,
            { c1, c2, stored },
          ).map((p) => `PG2: ${p}`),
        );
      }

      // PG3 — survey path: real access_state() RPC + profiles read + insert →
      // exactly one feedback row stamped from the DB (account age from the
      // trigger-provisioned profile, was_premium false, scored_count 0).
      {
        const u = await createUser(rng);
        const o = await drive(h, h.request({ token: u.token, body: { survey: VALID_SURVEY } }));
        const fb = await feedbackRows(u.id);
        const problems: string[] = [];
        if (o.status !== 200) problems.push(`status ${o.status}`);
        if (fb.length !== 1)
          problems.push(`feedback rows ${fb.length}; log=${h.errorLog.slice(-3).join(" | ")}`);
        const row = fb[0] ?? {};
        if (row.reason !== VALID_SURVEY.reason || row.wanted !== VALID_SURVEY.wanted)
          problems.push("reason/wanted mismatch");
        if (row.provider !== "google") problems.push(`provider ${row.provider}`);
        if (row.platform !== "ios" || row.app_version !== VALID_SURVEY.appVersion)
          problems.push("platform/app_version mismatch");
        if (Number(row.account_age_days) !== 0)
          problems.push(`account_age_days ${row.account_age_days}`);
        if (row.was_premium !== false) problems.push(`was_premium ${row.was_premium}`);
        if (Number(row.scored_count) !== 0) problems.push(`scored_count ${row.scored_count}`);
        if (o.supabaseRoundTrips !== 5) problems.push(`round trips ${o.supabaseRoundTrips}`);
        problemsAll.push(
          ...record(
            "PG3",
            "survey → feedback row stamped from real access_state()/profiles",
            STRESS_SEED + 70_002,
            o,
            problems,
            { fb },
          ).map((p) => `PG3: ${p}`),
        );
      }

      // PG4 — details at the route cap (500 chars, sanitized) fit the table's
      // 1000-char check constraint; an oversized payload is truncated, not lost.
      {
        const u = await createUser(rng);
        const details = "x".repeat(5_000);
        const o = await drive(
          h,
          h.request({ token: u.token, body: { survey: { ...VALID_SURVEY, details } } }),
        );
        const fb = await feedbackRows(u.id);
        const problems: string[] = [];
        if (o.status !== 200) problems.push(`status ${o.status}`);
        if (fb.length !== 1)
          problems.push(`feedback rows ${fb.length}; log=${h.errorLog.slice(-3).join(" | ")}`);
        if (fb[0] && String(fb[0].details).length > 1000)
          problems.push(`details ${String(fb[0].details).length} chars`);
        problemsAll.push(
          ...record(
            "PG4",
            "oversized survey details are bounded and still recorded",
            STRESS_SEED + 70_003,
            o,
            problems,
            { detailsLen: fb[0] ? String(fb[0].details).length : null },
          ).map((p) => `PG4: ${p}`),
        );
      }

      // PG5 — RLS: the bearer's DB identity (JWT sub) differs from the user
      // Auth vouches for → the upsert of authed.id's row is refused by RLS
      // (42501) → generic 503, and NO row is written for either identity.
      {
        const a = await createUser(rng);
        const b = await createUser(rng);
        // Session says A, JWT sub says B.
        h.sessions.set(b.token, a.id);
        h.calls = [];
        const o = await drive(h, h.request({ token: b.token, body: {} }));
        const rowsA = await deletionRows(a.id);
        const rowsB = await deletionRows(b.id);
        const problems: string[] = [];
        if (o.status !== 503) problems.push(`status ${o.status}`);
        if (rowsA.length + rowsB.length !== 0)
          problems.push(`rows written A=${rowsA.length} B=${rowsB.length}`);
        const upsert = h.callsTo("rest.deletion_upsert");
        if (upsert.length !== 1) problems.push(`upsert calls ${upsert.length}`);
        const bodyText = JSON.stringify(o.body);
        if (/42501|row-level|policy|account_deletion_requests/i.test(bodyText))
          problems.push("5xx body leaks DB detail");
        problemsAll.push(
          ...record(
            "PG5",
            "identity mismatch: RLS refuses the upsert → 503, nothing written, no leak",
            STRESS_SEED + 70_004,
            o,
            problems,
            { body: o.body, log: h.errorLog.slice(-1) },
          ).map((p) => `PG5: ${p}`),
        );
        h.sessions.delete(b.token);
      }

      // PG6 — an auth user with NO profile row (account_deletion_requests.user_id
      // references public.profiles): the upsert fails its FK (23503) → generic
      // 503, nothing written, no leak of the constraint name. The mobile client
      // classifies this as retryable, but it can never succeed until the profile
      // exists — recorded as an observation (abnormal state, bootstrap always
      // provisions the profile via trigger).
      {
        const u = await createUser(rng, { profile: false });
        h.errorLog = [];
        const o = await drive(h, h.request({ token: u.token, body: { survey: VALID_SURVEY } }));
        const fb = await feedbackRows(u.id);
        const stored = await deletionRows(u.id);
        const problems: string[] = [];
        if (o.status !== 503) problems.push(`status ${o.status}`);
        if (stored.length !== 0) problems.push(`deletion rows ${stored.length}`);
        if (fb.length !== 0) problems.push(`feedback rows ${fb.length}`);
        if (/23503|foreign key|profiles/i.test(JSON.stringify(o.body)))
          problems.push("5xx body leaks DB detail");
        if (!h.errorLog.some((l) => l.includes("Account deletion")))
          problems.push("upsert failure not logged");
        problemsAll.push(
          ...record(
            "PG6",
            "no profile row: upsert FK to profiles fails → 503, nothing written, no leak",
            STRESS_SEED + 70_005,
            o,
            problems,
            { body: o.body, log: h.errorLog.slice() },
          ).map((p) => `PG6: ${p}`),
        );
      }

      // PG7 — apple provider stamps provider='apple'.
      {
        const u = await createUser(rng, { provider: "apple" });
        const o = await drive(
          h,
          h.request({ token: u.token, body: { survey: { reason: "other", details: "bye" } } }),
        );
        const fb = await feedbackRows(u.id);
        const problems: string[] = [];
        if (o.status !== 200) problems.push(`status ${o.status}`);
        if (fb.length !== 1 || fb[0].provider !== "apple")
          problems.push(`feedback ${JSON.stringify(fb)}`);
        if (fb[0] && fb[0].wanted !== null) problems.push("wanted should be null");
        problemsAll.push(
          ...record("PG7", "minimal survey, apple provider", STRESS_SEED + 70_006, o, problems, {
            fb,
          }).map((p) => `PG7: ${p}`),
        );
      }

      // PG8 — concurrency, one user: the whole 3/hour budget fired at once
      // (plus one extra that must be 429) against the real DB → the 3 succeed,
      // exactly one row, the row holds one of the returned challenges (last
      // committed wins), the other 2 returned challenges are dead.
      {
        const u = await createUser(rng);
        h.calls = [];
        const outs = await Promise.all(
          Array.from({ length: PER_USER_BUDGET + 1 }, () =>
            drive(h, h.request({ token: u.token, body: {} })),
          ),
        );
        const stored = await deletionRows(u.id);
        const okOuts = outs.filter((o) => o.status === 200);
        const challenges = okOuts.map((o) =>
          String((o.body as Record<string, unknown>)?.challenge),
        );
        const problems: string[] = [];
        const statuses = outs.map((o) => o.status).sort();
        if (JSON.stringify(statuses) !== JSON.stringify([200, 200, 200, 429]))
          problems.push(`statuses ${JSON.stringify(statuses)}`);
        if (stored.length !== 1) problems.push(`rows ${stored.length}`);
        if (new Set(challenges).size !== okOuts.length) problems.push("duplicate challenges");
        if (!challenges.includes(String(stored[0]?.challenge)))
          problems.push("stored challenge is none of the returned ones");
        const o = outs[outs.length - 1];
        problemsAll.push(
          ...record(
            "PG8",
            `${PER_USER_BUDGET + 1} overlapping requests, one user → 3×200 + 429, one row, 2 dead challenges`,
            STRESS_SEED + 70_007,
            o,
            problems,
            {
              statuses,
              liveChallenge: stored[0]?.challenge,
              deadChallenges: challenges.filter((c) => c !== stored[0]?.challenge).length,
              latencies: outs.map((x) => x.latencyMs),
            },
          ).map((p) => `PG8: ${p}`),
        );
      }

      // PG9 — concurrency, distinct users with surveys: LANES users at once →
      // LANES deletion rows + LANES feedback rows, no cross-talk.
      {
        const users = [];
        for (let i = 0; i < LANES; i++) users.push(await createUser(rng));
        const outs = await Promise.all(
          users.map((u) => drive(h, h.request({ token: u.token, body: { survey: VALID_SURVEY } }))),
        );
        const problems: string[] = [];
        const statuses = outs.map((o) => o.status);
        if (statuses.some((s) => s !== 200)) problems.push(`statuses ${JSON.stringify(statuses)}`);
        for (const [i, u] of users.entries()) {
          const stored = await deletionRows(u.id);
          const fb = await feedbackRows(u.id);
          const c = (outs[i].body as Record<string, unknown>)?.challenge;
          if (stored.length !== 1 || stored[0].challenge !== c)
            problems.push(`user ${i}: row/challenge mismatch`);
          if (fb.length !== 1) problems.push(`user ${i}: feedback rows ${fb.length}`);
        }
        problemsAll.push(
          ...record(
            "PG9",
            `${LANES} distinct users with surveys at once → ${LANES} rows + ${LANES} feedback rows`,
            STRESS_SEED + 70_008,
            outs[0],
            problems,
            { statuses },
          ).map((p) => `PG9: ${p}`),
        );
      }

      // PG10 — a forged (unsigned) bearer: the stub Auth vouches for it, but
      // the real PostgREST rejects the signature → 503, nothing written.
      {
        const u = await createUser(rng);
        const [hdr, payload] = u.token.split(".");
        const forged = `${hdr}.${payload}.forged`;
        h.sessions.set(forged, u.id);
        h.errorLog = [];
        const o = await drive(h, h.request({ token: forged, body: {} }));
        const stored = await deletionRows(u.id);
        const problems: string[] = [];
        if (o.status !== 503) problems.push(`status ${o.status}`);
        if (stored.length !== 0) problems.push(`rows ${stored.length}`);
        if (/jwt|signature|PGRST/i.test(JSON.stringify(o.body)))
          problems.push("5xx body leaks PostgREST detail");
        problemsAll.push(
          ...record(
            "PG10",
            "bad JWT signature at PostgREST → 503, nothing written, no leak",
            STRESS_SEED + 70_009,
            o,
            problems,
            { body: o.body, log: h.errorLog.slice() },
          ).map((p) => `PG10: ${p}`),
        );
      }

      // Seeded random survey shapes against the real check constraints: every
      // accepted survey must land as exactly one row; every request must be 200.
      // Vocabulary mirrors apps/mobile/src/account/deletion.ts ACCOUNT_DELETION_REASONS.
      const REASONS = [
        "not_using",
        "not_helpful",
        "scores_inaccurate",
        "technical_issues",
        "too_expensive",
        "privacy",
        "other",
        "bogus_reason",
      ];
      const randomRows: Array<{
        seed: number;
        survey: unknown;
        status: number;
        feedbackRows: number;
        expectedRows: number;
        outcome: string;
      }> = [];
      let randomBroken = 0;
      for (let i = 0; i < STRESS_ITER; i++) {
        const seed = STRESS_SEED + 71_000 + i;
        const r = new Prng(seed);
        const u = await createUser(r);
        const reason = r.pick(REASONS);
        const survey: Record<string, unknown> = { reason };
        if (r.next() < 0.5)
          survey.wanted = r.pick(["price", "accuracy", "nothing", "coaching", 42, null]);
        if (r.next() < 0.7)
          survey.details = r.pick([
            "",
            "a",
            "é".repeat(r.int(1, 700)),
            "\u0000ctl\u202e",
            "x".repeat(r.int(400, 1_200)),
          ]);
        if (r.next() < 0.5)
          survey.platform = r.pick(["ios", "android-ish", "x".repeat(r.int(1, 40))]);
        if (r.next() < 0.5) survey.appVersion = r.pick(["1.0.0", "x".repeat(r.int(1, 120)), 7]);
        h.errorLog = [];
        const o = await drive(h, h.request({ token: u.token, body: { survey } }));
        const fb = await feedbackRows(u.id);
        const expectedRows = reason === "bogus_reason" ? 0 : 1;
        const ok = o.status === 200 && fb.length === expectedRows;
        if (!ok) randomBroken += 1;
        randomRows.push({
          seed,
          survey,
          status: o.status,
          feedbackRows: fb.length,
          expectedRows,
          outcome: ok ? "HELD" : `BROKEN ${h.errorLog.slice(-1).join("")}`,
        });
      }

      const report = {
        seed: STRESS_SEED,
        lanes: LANES,
        rows,
        random: { iterations: STRESS_ITER, broken: randomBroken, rows: randomRows },
        replay: `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${STRESS_ITER} STRESS_PG_LANES=${LANES} deno test -A --no-check --config deno.json stress_delete_request_pg.test.ts`,
      };
      const out = await writeReport("delete_request_pg", report);
      console.log(
        `[stress] pg: ${rows.length} cases, ${rows.filter((r) => r.outcome === "BROKEN").length} broken; random ${STRESS_ITER} iterations, ${randomBroken} broken → ${out ?? "(STRESS_OUT_DIR unset)"}`,
      );
      assertEquals(problemsAll, []);
      assertEquals(randomBroken, 0);
      assert(rows.length >= 10);
    }),
});

Deno.test({
  name: `STRESS delete-request (postgres:16 + real PostgREST): ${PG_LOAD_N} requests — real-DB p50/p95 + round trips`,
  ignore,
  fn: () =>
    withPg(async () => {
      const rng = new Prng(STRESS_SEED + 72_000);
      // Each user may only spend PER_USER_BUDGET requests per hour.
      const users: PgUser[] = [];
      for (let i = 0; i < Math.ceil(PG_LOAD_N / PER_USER_BUDGET); i++)
        users.push(await createUser(rng));
      const samples: Record<string, number[]> = { "no-survey": [], survey: [] };
      const trips: Record<string, Set<number>> = { "no-survey": new Set(), survey: new Set() };
      const statuses: Record<string, number> = {};
      const t0 = performance.now();
      for (let i = 0; i < PG_LOAD_N; i++) {
        const u = users[Math.floor(i / PER_USER_BUDGET)];
        const withSurvey = rng.next() < 0.5;
        const o = await drive(
          h,
          h.request({ token: u.token, body: withSurvey ? { survey: VALID_SURVEY } : {} }),
        );
        statuses[o.status] = (statuses[o.status] ?? 0) + 1;
        const path = withSurvey ? "survey" : "no-survey";
        samples[path].push(o.latencyMs);
        trips[path].add(o.supabaseRoundTrips);
      }
      const wallMs = Math.round(performance.now() - t0);
      const report = {
        requests: PG_LOAD_N,
        users: users.length,
        wallMs,
        statusCounts: statuses,
        byPath: Object.fromEntries(
          Object.entries(samples).map(([k, v]) => [
            k,
            { latency: latencyStats(v), supabaseRoundTrips: [...trips[k]].sort() },
          ]),
        ),
      };
      const out = await writeReport("delete_request_pg_load", report);
      console.log(
        `[stress] pg load: ${JSON.stringify(report)} → ${out ?? "(STRESS_OUT_DIR unset)"}`,
      );
      assertEquals(statuses, { 200: PG_LOAD_N });
    }),
});
