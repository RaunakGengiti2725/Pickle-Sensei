/**
 * STRESS (boundary-malformed) — edge caps vs Postgres CHECK bounds, against a
 * disposable postgres:16 with every migration applied (never a hosted project).
 *
 * The in-process handler campaign (stress_edge_http_handler_boundary.test.ts)
 * stops at the stubbed PostgREST boundary: it records exactly what the edge
 * forwards after `sanitizeUserText` / route validation. This campaign takes
 * those SAME forwarded shapes (same generators, same caps as index.ts) and
 * asks Postgres the question the stub cannot: does the database accept every
 * value the edge accepted? A `23514` (CHECK violation) or `22P05` (\u0000 in
 * json) here is a value that passed edge validation and then fails at the
 * store — which the edge can only report as a generic 503 / `write_failed`.
 *
 *   ./xc_pg_up.sh                                          # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     STRESS_ITER=3000 deno test -A --no-check --config deno.json stress_edge_http_pg_caps.test.ts
 *
 * Known RED at 1fb0efd7 (findings pinned by this test, see the campaign report):
 *   - consent grant: edge caps consent_version/capture_mode at 64 code points,
 *     consent_records_bounds allows 50 → 23514 for any 51–64 cp value;
 *   - permit reserve / shots sync: idempotencyKey, shotType and versionVector.*
 *     are forwarded unsanitized, so a \u0000 in them → 22P05 at the RPC.
 *
 * Without XC_PG_URL the test is `ignore`d — an ignored run is NOT a pass.
 * Every iteration runs in a transaction that is rolled back (the DB is left
 * as found); every row is replayable from its seed.
 */

import postgres from "postgres";
import { assertEquals } from "@std/assert";
import { sanitizeUserText } from "../http.ts";
import {
  type AtomKind,
  brokenSummary,
  genString,
  type IterationRow,
  type LengthClass,
  preview,
  Prng,
  runCampaign,
  STRESS_ITER,
  STRESS_SEED,
  writeCampaign,
} from "./stress_boundary_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const FILE = "stress_edge_http_pg_caps.test.ts";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

// Edge-side caps, verbatim from index.ts (the values the edge forwards are at
// most this many code points after sanitizeUserText).
const EDGE = {
  consentVersion: 64, // grantConsent: sanitizeUserText(consentVersion, 64)
  consentSource: 64,
  consentDevice: 512,
  captureMode: 64,
  skillLevel: 64, // onboarding validates ≤64 after sanitizeUserText(…, 200)
  goal: 64,
  biggestProblem: 256,
  firstName: 40,
  deletionDetails: 500, // DELETION_SURVEY_DETAILS_MAX
  deletionAppVersion: 64,
  idempotencyKey: 128, // reserveAnalysisPermit: .length > 128 → 400
  shotType: 64, // parseSyncShot: .length > 64 → invalid
} as const;

const USER_ID = "5e5e5e5e-0000-4000-8000-" + (STRESS_SEED >>> 0).toString(16).padStart(12, "0");
const ROLLBACK = Symbol("rollback");

const CAP_CLASSES: readonly LengthClass[] = ["one", "short", "medium", "cap_edge", "large"];
/** Unsanitized fields are only length-gated, so `large` is always an edge
 * reject; the mix is kept around the cap. */
const RAW_CLASSES: readonly LengthClass[] = ["one", "short", "medium", "cap_edge", "cap_edge"];
const SHORT_CLASSES: readonly LengthClass[] = ["one", "short", "short", "cap_edge"];

/** Wire-reachable atoms: a request body is UTF-8-decoded by the handler, so a
 * lone surrogate can never reach a route string (it decodes as U+FFFD). */
const WIRE_KINDS: ReadonlyArray<readonly [number, AtomKind]> = [
  [30, "ascii"],
  [4, "c0"],
  [3, "c1"],
  [1, "del"],
  [5, "zwbidi"],
  [3, "invisible_kept"],
  [8, "whitespace"],
  [8, "emoji"],
  [4, "combining"],
  [3, "nfc"],
  [3, "nfd"],
  [3, "nul"],
  [4, "injection"],
  [6, "script"],
];

/** A client string the edge would accept for a field capped at `cap`
 * (already sanitized/trimmed exactly like the route does), or null when the
 * generated value would not pass edge validation at all. */
function edgeValue(p: Prng, cap: number, sanitizeCap = cap): string | null {
  const raw = genString(p, { lengthClass: p.pick(CAP_CLASSES), cap, kinds: WIRE_KINDS });
  const v = sanitizeUserText(raw, sanitizeCap);
  if (v.length === 0 || Array.from(v).length > cap) return null;
  return v;
}

/** Runs `fn` as the authenticated user inside a transaction that is always
 * rolled back; returns the SQLSTATE of the first failure, or "ok". */
async function attempt(
  sql: Sql,
  fn: (tx: Tx) => Promise<void>,
): Promise<{ state: string; message: string }> {
  let out = { state: "ok", message: "" };
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local role authenticated`);
      await tx.unsafe(`set local request.jwt.claim.sub = '${USER_ID}'`);
      try {
        await fn(tx);
      } catch (error) {
        const e = error as { code?: string; message?: string };
        out = { state: e.code ?? "error", message: e.message ?? String(error) };
      }
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return out;
}

async function setupUser(sql: Sql): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${USER_ID}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${USER_ID}', '${USER_ID}@example.com', '{"provider":"apple"}')`,
  );
  await sql.unsafe(
    `insert into public.profiles (id, email, provider) values ('${USER_ID}', '${USER_ID}@example.com', 'apple') on conflict (id) do nothing`,
  );
}

type Case =
  | "consent_grant"
  | "consent_withdraw"
  | "onboarding"
  | "deletion_feedback"
  | "permit_key"
  | "shot_type";
const CASES: readonly Case[] = [
  "consent_grant",
  "consent_withdraw",
  "onboarding",
  "deletion_feedback",
  "permit_key",
  "shot_type",
];

function hasNul(values: Array<string | null>): boolean {
  return values.some((v) => v !== null && v.includes("\u0000"));
}

async function iteration(sql: Sql, p: Prng): Promise<Omit<IterationRow, "i" | "seed">> {
  const kind = p.pick(CASES);
  switch (kind) {
    case "consent_grant": {
      const consentVersion = edgeValue(p, EDGE.consentVersion);
      const source = p.chance(0.7) ? edgeValue(p, EDGE.consentSource) : null;
      const device = p.chance(0.7) ? edgeValue(p, EDGE.consentDevice) : null;
      const captureMode = p.chance(0.7) ? edgeValue(p, EDGE.captureMode) : null;
      if (consentVersion === null)
        return { case: kind, input: "edge rejects", outcome: "HELD", metrics: { skipped: true } };
      const r = await attempt(sql, async (tx) => {
        await tx`insert into public.consent_records (user_id, scope, consent_version, action, source, device, capture_mode)
          values (${USER_ID}, 'video_analysis', ${consentVersion}, 'grant', ${source}, ${device}, ${captureMode})`;
      });
      const cp = {
        consentVersion: Array.from(consentVersion).length,
        captureMode: captureMode ? Array.from(captureMode).length : 0,
      };
      return {
        case: kind,
        input: `consent_version=${preview(consentVersion, 80)} capture_mode=${preview(captureMode, 80)} source=${preview(source, 40)} device.cp=${device ? Array.from(device).length : 0}`,
        outcome: r.state === "ok" ? "HELD" : "BROKEN",
        detail:
          r.state === "ok"
            ? undefined
            : `edge-accepted consent row refused by Postgres: ${r.state} ${preview(r.message, 160)}`,
        metrics: { state: r.state, ...cp },
      };
    }
    case "consent_withdraw": {
      const source = edgeValue(p, EDGE.consentSource);
      const device = edgeValue(p, EDGE.consentDevice);
      const r = await attempt(sql, async (tx) => {
        await tx`insert into public.consent_records (user_id, scope, consent_version, action, source, device)
          values (${USER_ID}, 'model_training', null, 'withdraw', ${source}, ${device})`;
      });
      return {
        case: kind,
        input: `source=${preview(source, 60)} device.cp=${device ? Array.from(device).length : 0}`,
        outcome: r.state === "ok" ? "HELD" : "BROKEN",
        detail:
          r.state === "ok"
            ? undefined
            : `edge-accepted withdraw row refused by Postgres: ${r.state} ${preview(r.message, 160)}`,
        metrics: { state: r.state },
      };
    }
    case "onboarding": {
      const skill = edgeValue(p, EDGE.skillLevel, 200);
      const goal = edgeValue(p, EDGE.goal, 200);
      const problem = edgeValue(p, EDGE.biggestProblem, 1000);
      const firstName = p.chance(0.6) ? edgeValue(p, EDGE.firstName, 200) : null;
      if (skill === null || goal === null || problem === null) {
        return { case: kind, input: "edge rejects", outcome: "HELD", metrics: { skipped: true } };
      }
      const r = await attempt(sql, async (tx) => {
        await tx`update public.profiles set skill_level = ${skill}, primary_goal = ${goal}, biggest_problem = ${problem},
          first_name = ${firstName}, handedness = 'right' where id = ${USER_ID}`;
      });
      return {
        case: kind,
        input: `skill.cp=${Array.from(skill).length} goal.cp=${Array.from(goal).length} problem.cp=${Array.from(problem).length} first.cp=${firstName ? Array.from(firstName).length : 0}`,
        outcome: r.state === "ok" ? "HELD" : "BROKEN",
        detail:
          r.state === "ok"
            ? undefined
            : `edge-accepted onboarding refused by Postgres: ${r.state} ${preview(r.message, 160)}`,
        metrics: { state: r.state },
      };
    }
    case "deletion_feedback": {
      const details = p.chance(0.8) ? edgeValue(p, EDGE.deletionDetails) : null;
      const appVersion = p.chance(0.8) ? edgeValue(p, EDGE.deletionAppVersion) : null;
      const r = await attempt(sql, async (tx) => {
        await tx`insert into public.account_deletion_feedback (user_id, reason, details, provider, platform, app_version, wanted)
          values (${USER_ID}, 'other', ${details}, 'apple', 'ios', ${appVersion}, null)`;
      });
      return {
        case: kind,
        input: `details.cp=${details ? Array.from(details).length : 0} app_version=${preview(appVersion, 80)}`,
        outcome: r.state === "ok" ? "HELD" : "BROKEN",
        detail:
          r.state === "ok"
            ? undefined
            : `edge-accepted deletion survey refused by Postgres: ${r.state} ${preview(r.message, 160)}`,
        metrics: { state: r.state },
      };
    }
    case "permit_key": {
      // reserveAnalysisPermit forwards the key UNsanitized: only
      // `typeof === "string" && trim() && length <= 128` gate it.
      const key = genString(p, {
        lengthClass: p.pick(RAW_CLASSES),
        cap: EDGE.idempotencyKey,
        kinds: WIRE_KINDS,
      });
      if (!key.trim() || key.length > EDGE.idempotencyKey)
        return { case: kind, input: "edge rejects", outcome: "HELD", metrics: { skipped: true } };
      // PostgREST passes RPC args by extracting them from the JSON body —
      // the same `json ->> key` path modelled here.
      // (postgres.js serializes an object bound to a json parameter with
      // JSON.stringify — the same wire text supabase-js sends.)
      let result = "";
      const r = await attempt(sql, async (tx) => {
        const rows = await tx.unsafe<{ result: string }[]>(
          `select result from public.reserve_analysis_permit(p_idempotency_key := ($1::json)->>'p_idempotency_key')`,
          [sql.json({ p_idempotency_key: key })],
        );
        result = rows[0]?.result ?? "";
      });
      const nul = hasNul([key]);
      return {
        case: kind,
        input: `idempotencyKey=${preview(key, 120)} (len=${key.length} cp=${Array.from(key).length} nul=${nul})`,
        outcome: r.state === "ok" ? "HELD" : "BROKEN",
        detail:
          r.state === "ok"
            ? undefined
            : `edge-accepted idempotencyKey fails at the RPC: ${r.state} ${preview(r.message, 160)}`,
        metrics: { state: r.state, result, nul, keyLen: key.length },
      };
    }
    case "shot_type": {
      // parseSyncShot forwards shotType unsanitized (only trim/length ≤ 64
      // are checked); apply_synced_shot takes the whole shot as jsonb.
      const shotType = genString(p, {
        lengthClass: p.pick(SHORT_CLASSES),
        cap: EDGE.shotType,
        kinds: WIRE_KINDS,
      });
      if (!shotType.trim() || shotType.length > EDGE.shotType)
        return { case: kind, input: "edge rejects", outcome: "HELD", metrics: { skipped: true } };
      // versionVector entries are forwarded unsanitized too (≤64 code units)
      const version = genString(p, {
        lengthClass: p.pick(SHORT_CLASSES),
        cap: 64,
        kinds: WIRE_KINDS,
      });
      if (!version.trim() || version.length > 64)
        return { case: kind, input: "edge rejects", outcome: "HELD", metrics: { skipped: true } };
      const versionVector = {
        appVersion: version,
        modelBundleVersion: "1",
        poseModelVersion: "1",
        paddleModelVersion: "1",
        strokeDetectorVersion: "1",
        phaseModelVersion: "1",
        scoringModelVersion: "1",
        shotConfigVersion: "1",
      };
      const shot = {
        id: p.uuid(),
        analysisPermitId: "",
        sessionId: null,
        shotType,
        cameraView: "side",
        capturedAt: "2026-08-31T10:00:00.000Z",
        startMs: 0,
        contactMs: 500,
        endMs: 1000,
        overallScore: 7.5,
        confidence: 0.9,
        resultKind: "scored",
        phases: [],
        checkpoints: [],
        versionVector,
      };
      let status = "";
      const r = await attempt(sql, async (tx) => {
        // a live reserved permit, exactly as the app holds one before syncing
        const reserved = await tx.unsafe<{ permit_id: string }[]>(
          `select permit_id from public.reserve_analysis_permit(p_idempotency_key := $1)`,
          [`stress-${p.uuid()}`],
        );
        shot.analysisPermitId = reserved[0].permit_id;
        const rows = await tx.unsafe<{ status: string }[]>(
          `select public.apply_synced_shot($1::jsonb) as status`,
          [sql.json(shot)],
        );
        status = rows[0]?.status ?? "";
      });
      const nul = hasNul([shotType, version]);
      // the RPC swallows write errors into `shot.write_failed:<SQLSTATE>`
      const state =
        r.state === "ok" && status.startsWith("shot.write_failed")
          ? status.slice("shot.write_failed:".length)
          : r.state;
      const held = state === "ok" && status === "accepted";
      return {
        case: kind,
        input: `shotType=${preview(shotType, 100)} (len=${shotType.length} cp=${Array.from(shotType).length}) appVersion=${preview(version, 60)} nul=${nul}`,
        outcome: held ? "HELD" : "BROKEN",
        detail: held
          ? undefined
          : `edge-accepted shot fails at the RPC: ${state} status=${status} ${preview(r.message, 160)}`,
        metrics: { state, status, nul },
      };
    }
  }
}

Deno.test({
  name: "stress/pg_caps: every value the edge forwards is accepted by Postgres (edge cap ≤ DB CHECK, no \\u0000 into json)",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    const states: Record<string, number> = {};
    const nulSeeds: number[] = [];
    const capSeeds: number[] = [];
    try {
      await setupUser(sql);
      const report = await runCampaign(
        "pg_caps",
        FILE,
        async (p, _i, seed) => {
          const row = await iteration(sql, p);
          const state = String(row.metrics?.state ?? "skipped");
          states[`${row.case}:${state}`] = (states[`${row.case}:${state}`] ?? 0) + 1;
          if (state === "22P05") nulSeeds.push(seed);
          if (state === "23514") capSeeds.push(seed);
          return row;
        },
        { metrics: () => ({ states, nulSeeds, capSeeds, user: USER_ID }) },
      );
      const path = await writeCampaign(report);
      console.log(
        `[pg_caps] executed=${report.executed} held=${report.held} broken=${report.broken} → ${path}`,
      );
      console.log(JSON.stringify(states));
      if (report.broken) console.log(brokenSummary(report));
      assertEquals(report.executed, STRESS_ITER);
      assertEquals(
        report.broken,
        0,
        `edge-accepted values refused by Postgres:\n${brokenSummary(report)}`,
      );
    } finally {
      await sql.unsafe(`delete from auth.users where id = '${USER_ID}'`);
      await sql.end();
    }
  },
});
