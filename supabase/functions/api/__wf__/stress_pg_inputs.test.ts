// stress-edge-http — where http.ts inputs meet POSTGRES.
//
// Part A (always runs, real handler in-process, fake Supabase): which free-text
// fields reach PostgREST sanitized (sanitizeUserText) and which reach it raw,
// and how the route classifies PostgREST's refusal of a raw NUL (SQLSTATE
// 22P05, "unsupported Unicode escape sequence") on apply_synced_shot(jsonb).
//
// Part B (needs XC_PG_URL from ./xc_pg_up.sh — disposable postgres:16 with
// shim_auth.sql + every migration; `ignore`d otherwise, which is NOT a pass):
//   B1 apply_synced_shot(jsonb) with a NUL in an unsanitized field → 22P05.
//   B2 seeded sanitizer outputs written through the real profiles column path
//      (role authenticated, RLS) and through jsonb → byte-identical readback.
//   B3 the hot RPCs' real latency (access_state / reserve / apply) as the
//      per-round-trip cost the load campaign's counts multiply into.
//
// Replay: STRESS_SEED=<seed> [STRESS_ITER=<n>] XC_PG_URL=… deno test -A --no-check --config deno.json stress_pg_inputs.test.ts

import postgres from "postgres";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { sanitizeUserText } from "../http.ts";
import { syncShotPayload } from "./xc_concurrency_harness.ts";
import {
  answer,
  edgeRequest,
  freshIp,
  isRecord,
  latencyStats,
  loadStressHarness,
  restoreProcessEnv,
  Rng,
  signIn,
  STRESS_ITER,
  STRESS_SEED,
  writeArtifact,
} from "./stress_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const pgIgnore = PG_URL === "";
if (pgIgnore) {
  console.log(
    "[stress/pg] XC_PG_URL unset → Part B ignored (UNKNOWN, not a pass)",
  );
}

const h = await loadStressHarness({ redis: false, seed: STRESS_SEED });

/** Free-text fields of the shots:sync payload the parser length-checks but
 * does NOT sanitize; each carries a NUL that Postgres jsonb cannot hold. */
const RAW_FIELDS: Array<
  { field: string; overrides: (nul: string) => Record<string, unknown> }
> = [
  { field: "shotType", overrides: (nul) => ({ shotType: `dink${nul}` }) },
  {
    field: "phases[].key",
    overrides: (nul) => ({
      phases: [{
        key: `backswing${nul}`,
        startMs: 0,
        representativeMs: 50,
        endMs: 100,
        confidence: 0.8,
      }],
    }),
  },
  {
    field: "checkpoints[].direction",
    overrides: (nul) => ({
      checkpoints: [{
        key: "contact",
        score: 70,
        confidence: 0.8,
        band: "green",
        direction: `too_high${nul}`,
        severity: 0.2,
        applicable: true,
      }],
    }),
  },
  {
    field: "versionVector.appVersion",
    overrides: (nul) => ({
      versionVector: {
        ...syncShotPayload("x", "y").versionVector as Record<string, string>,
        appVersion: `1.0.0${nul}`,
      },
    }),
  },
];

const PGRST_22P05 = () =>
  new Response(
    JSON.stringify({
      code: "22P05",
      details: "\\u0000 cannot be converted to text.",
      hint: null,
      message: "unsupported Unicode escape sequence",
    }),
    {
      status: 400,
      headers: { "Content-Type": "application/json" },
    },
  );

Deno.test("stress/pg A: sanitized vs raw free text at the PostgREST boundary — NUL in shots:sync fields reaches the RPC and is classified retryable", async () => {
  h.clearFaults();
  const ip = freshIp();
  const user = await signIn(h, "0000c0de-0000-4000-8000-0000000000a1", ip);
  const rows: Array<Record<string, unknown>> = [];

  // Sanitized path: onboarding firstName — the PATCH body must carry no NUL.
  {
    const mark = h.mark();
    const out = await answer(
      h,
      edgeRequest("PUT", "/v1/me/onboarding", {
        token: user.accessToken,
        ip,
        body: {
          handedness: "right",
          skillLevel: "beginner",
          goal: "consistency",
          biggestProblem: "pop-ups",
          firstName: "Pat\u0000\u202e\u200b",
        },
      }),
    );
    const patch = h.since(mark).find((c) =>
      c.upstream === "rest" && c.method === "PATCH"
    );
    assert(patch, "onboarding issued a profiles PATCH");
    const sent = JSON.parse(patch.body) as Record<string, unknown>;
    rows.push({
      field: "onboarding.firstName",
      status: out.status,
      sentValue: sent.first_name,
      sanitized: true,
    });
    assertEquals(out.status, 200, out.text);
    assertEquals(sent.first_name, "Pat");
  }

  // Raw path: each unsanitized shots:sync field carries a NUL to the RPC.
  for (const [i, raw] of RAW_FIELDS.entries()) {
    const reserve = await answer(
      h,
      edgeRequest("POST", "/v1/analysis-permits", {
        token: user.accessToken,
        ip,
        body: { idempotencyKey: `nul-${i}` },
      }),
    );
    // Free users get two permits; the rest ride a permit-less low-confidence shot
    // (the RPC would refuse the permit — irrelevant here, the JSON never parses).
    const permitId = reserve.status === 200 && isRecord(reserve.body) &&
        isRecord(reserve.body.permit)
      ? String(reserve.body.permit.id)
      : "0000c0de-0000-4000-8000-00000000dead";
    const shotId = `0000c0de-0000-4000-8000-0000000000${
      (0xb0 + i).toString(16)
    }`;
    const body = {
      shots: [
        syncShotPayload(shotId, permitId, {
          ...raw.overrides("\u0000"),
          ...(reserve.status === 200
            ? {}
            : { resultKind: "low_confidence", overallScore: null }),
        }),
      ],
    };
    h.setFaults([{
      id: `pgrst.22P05.${raw.field}`,
      upstream: "rest",
      match: (_request, op, sent) =>
        op === "rest:POST rpc/apply_synced_shot" && sent.includes("\\u0000"),
      mode: { kind: "mutate", mutate: () => PGRST_22P05() },
    }]);
    const mark = h.mark();
    const out = await answer(
      h,
      edgeRequest("POST", "/v1/shots:sync", {
        token: user.accessToken,
        ip,
        body,
      }),
    );
    h.clearFaults();
    const rpc = h.since(mark).find((c) =>
      c.op === "rest:POST rpc/apply_synced_shot"
    );
    const rejected = isRecord(out.body) && Array.isArray(out.body.rejected)
      ? out.body.rejected as Array<Record<string, unknown>>
      : [];
    rows.push({
      field: raw.field,
      status: out.status,
      rpcCalled: Boolean(rpc),
      rpcBodyCarriesNul: rpc?.body.includes("\\u0000") ?? false,
      rpcFault: rpc?.fault ?? null,
      rejected: rejected.map((r) => ({ code: r.code, message: r.message })),
      sanitized: false,
    });
    assert(rpc, `${raw.field}: the parser accepted the NUL and issued the RPC`);
    assertStringIncludes(
      rpc.body,
      "\\u0000",
      `${raw.field}: NUL reached PostgREST unsanitized`,
    );
    assertEquals(rpc.fault, `pgrst.22P05.${raw.field}`);
    assertEquals(out.status, 200);
    assertEquals(rejected.length, 1);
    assertEquals(rejected[0].code, "shot.write_failed");
    assertStringIncludes(String(rejected[0].message), "will retry");
  }
  await writeArtifact("pg_nul_boundary.json", { seed: STRESS_SEED, rows });
});

// ── Part B: real Postgres ────────────────────────────────────────────────────

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `delete from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', '${userId}')`,
  );
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data) values ('google', '${userId}', '${userId}', '{"sub":"${userId}"}')`,
  );
}

function pgUser(n: number): string {
  return `0000c0de-1111-4111-8111-${String(n).padStart(12, "0")}`;
}

/** Character palette for the sanitizer round trip: what the fuzz in
 * stress_http_helpers.test.ts generates, compressed to one list. */
const PALETTE = [
  "\u0000",
  "\u0007",
  "\u001b",
  "\r\n",
  "\u0085",
  "\u009f",
  "\u200b",
  "\u200f",
  "\u202e",
  "\u2066",
  "\u2069",
  "\ufeff",
  "\u00ad",
  "\u2060",
  "\u034f",
  "\ud83d\ude00",
  "\u{1f3d3}",
  "\u{e0041}",
  "\ud83d",
  "\udc00",
  "é",
  "e\u0301",
  "a\u0300\u0301\u0302\u0303",
  "Ω",
  "Ω",
  "Α",
  "A",
  "а",
  "a",
  "Ｐ",
  "ط",
  "ن",
  "日本",
  "한글",
  "ไทย",
  " ",
  "\t",
  "\u3000",
  "\u00a0",
  "  ",
  "'",
  '"',
  "\\",
  ";",
  "--",
  "/*",
  "{",
  "}",
  "[",
  "]",
  "$1",
  "::text",
  "\\u0000",
  "%00",
  "Pat",
  "O'Brien",
  "Zoë",
  "Śmigły",
];

function seededText(rng: Rng, maxParts: number): string {
  const parts = rng.int(1, maxParts);
  let out = "";
  for (let i = 0; i < parts; i++) out += rng.pick(PALETTE);
  return out;
}

Deno.test({
  name:
    "stress/pg B1: apply_synced_shot(jsonb) refuses a NUL in an unsanitized field with SQLSTATE 22P05 (real postgres:16, every migration)",
  ignore: pgIgnore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      const userId = pgUser(1);
      await createUser(sql, userId);
      const results: Array<Record<string, unknown>> = [];
      for (const raw of RAW_FIELDS) {
        // Reserve a real permit so the ONLY reason to refuse is the payload.
        let permitId = "";
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, userId);
          const r = await tx.unsafe(
            `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('nul-${raw.field}') x`,
          );
          permitId = String(r[0].permit_id ?? "");
        });
        const shot = syncShotPayload(
          `0000c0de-2222-4222-8222-${String(results.length).padStart(12, "0")}`,
          permitId,
          {
            ...raw.overrides("\u0000"),
            resultKind: "low_confidence",
            overallScore: null,
          },
        );
        const flat = {
          ...shot,
          ...(shot.timestamps as Record<string, unknown>),
        };
        delete (flat as Record<string, unknown>).timestamps;
        let outcome: {
          ok: boolean;
          sqlstate?: string;
          message?: string;
          result?: string;
        } = { ok: false };
        try {
          await sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, userId);
            const r = await tx.unsafe(
              `select public.apply_synced_shot($1::text::jsonb) as result`,
              [JSON.stringify(flat)],
            );
            outcome = { ok: true, result: String(r[0].result) };
          });
        } catch (error) {
          const e = error as { code?: string; message?: string };
          outcome = { ok: false, sqlstate: e.code, message: e.message };
        }
        // Control: the same payload WITHOUT the NUL is accepted by the RPC.
        const clean = syncShotPayload(
          `0000c0de-2222-4222-8222-${
            String(100 + results.length).padStart(12, "0")
          }`,
          permitId,
          {
            ...raw.overrides(""),
            resultKind: "low_confidence",
            overallScore: null,
          },
        );
        const cleanFlat = {
          ...clean,
          ...(clean.timestamps as Record<string, unknown>),
        };
        delete (cleanFlat as Record<string, unknown>).timestamps;
        let control = "";
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, userId);
          const r = await tx.unsafe(
            `select public.apply_synced_shot($1::text::jsonb) as result`,
            [JSON.stringify(cleanFlat)],
          );
          control = String(r[0].result);
        });
        results.push({
          field: raw.field,
          permitId,
          withNul: outcome,
          withoutNul: control,
        });
        assertEquals(
          outcome.ok,
          false,
          `${raw.field}: Postgres accepted a NUL?`,
        );
        assertEquals(outcome.sqlstate, "22P05");
        assertEquals(control, "accepted", `${raw.field}: control payload`);
      }
      await writeArtifact("pg_nul_rpc.json", { seed: STRESS_SEED, results });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "stress/pg B2: seeded sanitizeUserText outputs round-trip byte-identical through profiles.first_name (authenticated, RLS) and jsonb",
  ignore: pgIgnore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    const rng = new Rng(STRESS_SEED);
    const n = 150 * STRESS_ITER;
    try {
      const userId = pgUser(2);
      await createUser(sql, userId);
      const table: Array<Record<string, unknown>> = [];
      let failed = 0;
      for (let i = 0; i < n; i++) {
        const raw = seededText(rng, 8);
        const cleaned = sanitizeUserText(raw, 40);
        if (cleaned.length < 1) {
          table.push({
            i,
            rawCodePoints: Array.from(raw).length,
            cleaned: "",
            outcome: "empty (route rejects with 400 before any write)",
          });
          continue;
        }
        let stored: string | null = null;
        let jsonb: string | null = null;
        let error: string | null = null;
        try {
          await sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, userId);
            await tx.unsafe(
              `update public.profiles set first_name = $1 where id = '${userId}'`,
              [cleaned],
            );
            const r = await tx.unsafe(
              `select first_name, ($1::text::jsonb)->>'v' as j from public.profiles where id = '${userId}'`,
              [JSON.stringify({ v: cleaned })],
            );
            stored = r[0].first_name as string;
            jsonb = r[0].j as string;
          });
        } catch (e) {
          error = (e as Error).message;
        }
        const ok = error === null && stored === cleaned && jsonb === cleaned;
        if (!ok) failed += 1;
        table.push({
          i,
          raw: JSON.stringify(raw),
          cleaned: JSON.stringify(cleaned),
          stored: stored === null ? null : JSON.stringify(stored),
          error,
          ok,
        });
      }
      await writeArtifact("pg_sanitizer_roundtrip.json", {
        seed: STRESS_SEED,
        n,
        failed,
        table,
      });
      assertEquals(failed, 0);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "stress/pg B3: real RPC latency per Supabase round trip — access_state / reserve_analysis_permit / apply_synced_shot",
  ignore: pgIgnore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    const rng = new Rng(STRESS_SEED ^ 0x5eed);
    const users = 40 * STRESS_ITER;
    const lat: Record<string, number[]> = {
      access_state: [],
      reserve_analysis_permit: [],
      apply_synced_shot: [],
      apply_replay: [],
    };
    const verdicts: string[] = [];
    try {
      for (let u = 0; u < users; u++) {
        const userId = pgUser(1000 + u);
        await createUser(sql, userId);
        for (let round = 0; round < 3; round++) {
          const key = `k-${u}-${round}-${rng.int(0, 1e9)}`;
          let permitId = "";
          let t = performance.now();
          await sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, userId);
            const r = await tx.unsafe(
              `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
            );
            verdicts.push(`reserve:${r[0].result}`);
            permitId = String(r[0].permit_id ?? "");
          });
          lat.reserve_analysis_permit.push(performance.now() - t);
          if (!permitId) continue;
          const shot = syncShotPayload(
            `0000c0de-3333-4333-8333-${
              String(u * 10 + round).padStart(12, "0")
            }`,
            permitId,
          );
          const flat = {
            ...shot,
            ...(shot.timestamps as Record<string, unknown>),
          };
          delete (flat as Record<string, unknown>).timestamps;
          t = performance.now();
          await sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, userId);
            const r = await tx.unsafe(
              `select public.apply_synced_shot($1::text::jsonb) as result`,
              [JSON.stringify(flat)],
            );
            verdicts.push(`apply:${r[0].result}`);
          });
          lat.apply_synced_shot.push(performance.now() - t);
          t = performance.now();
          await sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, userId);
            const r = await tx.unsafe(
              `select public.apply_synced_shot($1::text::jsonb) as result`,
              [JSON.stringify(flat)],
            );
            verdicts.push(`replay:${r[0].result}`);
          });
          lat.apply_replay.push(performance.now() - t);
          t = performance.now();
          await sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, userId);
            const r = await tx.unsafe(
              `select premium, scored_count, reserved_count from public.access_state()`,
            );
            verdicts.push(`access:scored=${r[0].scored_count}`);
          });
          lat.access_state.push(performance.now() - t);
        }
      }
      const hist: Record<string, number> = {};
      for (const v of verdicts) hist[v] = (hist[v] ?? 0) + 1;
      const report = {
        seed: STRESS_SEED,
        users,
        latencyMs: Object.fromEntries(
          Object.entries(lat).map(([k, v]) => [
            k,
            latencyStats(v.map((x) => Math.round(x * 100) / 100)),
          ]),
        ),
        verdicts: hist,
      };
      await writeArtifact("pg_rpc_latency.json", report);
      console.log(
        `[stress/pg] rpc latency: ${JSON.stringify(report.latencyMs)}`,
      );
      // Free tier: exactly two scored shots per user, third reserve is refused.
      assertEquals(hist["apply:accepted"], users * 2);
      assertEquals(hist["replay:accepted"], users * 2);
      assertEquals(hist["reserve:access.paywall_required"], users);
    } finally {
      await sql.end();
    }
  },
});

Deno.test("stress: restore the process environment for the suites that run after this module", () => {
  restoreProcessEnv();
});
