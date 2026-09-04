#!/usr/bin/env node
// Stress campaign: the three pg_cron maintenance sweeps
//   - expire-stale-analysis-permits   (update analysis_permits … created_at < now() - 24h)
//   - purge-expired-deletion-requests (delete account_deletion_requests … expires_at < now() - 1d)
//   - purge-old-webhook-events        (delete webhook_events … received_at < now() - 90d)
// racing LIVE writes from two authenticated users (RLS on) and the service role,
// on separate connections, under READ COMMITTED (default) and SERIALIZABLE.
//
// Every iteration is generated from a seed (scenario, boundary jitter around
// the sweep cutoff, interleaving delays, payload flavour, isolation level) and
// is replayable with STRESS_REPLAY=<seed>. Rows are committed (the race needs
// two transactions) and removed again at the end of the iteration.
//
// Invariants (any violation => BROKEN):
//   permit:   a shot row exists  <=> its permit is 'finalized' (scored) or 'released' (abstention);
//             a permit swept to released/expired never has a shot; the writer's
//             result is one of the typed statuses (never an exception, never 5xx);
//             a free user never ends with > 2 fresh reserved permits.
//   deletion: after upsert || sweep the row EXISTS with the new challenge (the
//             sweep may only remove rows whose expires_at is > 1 day old);
//             confirm-read never throws.
//   webhook:  every event inserted during the race is present unless it
//             deliberately reused a purged id; no row older than the cutoff
//             survives a completed sweep; the service insert never throws.
//   sweeps:   two sweep runners in parallel never deadlock (40P01) or error.
//
// Env: STRESS_ITER (default 40), STRESS_SEED (default 20260904), STRESS_REPLAY,
//      STRESS_OUT (default artifacts/stress), STRESS_PG_URL.
import path from "node:path";
import {
  REPO_ROOT,
  PG_URL,
  USERS,
  Rng,
  iterationSeed,
  envInt,
  connect,
  asUser,
  asServiceRole,
  seedUsers,
  loadSweeps,
  writeJson,
  describeError,
  postgrestStatus,
} from "./lib.mjs";

const ITER = envInt("STRESS_ITER", 40);
const CAMPAIGN_SEED = envInt("STRESS_SEED", 20260904);
const REPLAY = process.env.STRESS_REPLAY ? Number(process.env.STRESS_REPLAY) : null;
const OUT_DIR = path.resolve(REPO_ROOT, process.env.STRESS_OUT ?? "artifacts/stress");

const SCENARIOS = [
  "permit.stale_vs_apply",
  "permit.stale_vs_apply_malformed",
  "permit.stale_vs_reserve_same_key",
  "permit.stale_vs_reserve_new_key",
  "deletion.expiry_vs_upsert",
  "deletion.expiry_vs_confirm_read",
  "webhook.retention_vs_insert",
  "webhook.retention_vs_replayed_id",
  "sweeps.parallel_runners",
];

const VERSION_KEYS = [
  "appVersion",
  "modelBundleVersion",
  "poseModelVersion",
  "paddleModelVersion",
  "strokeDetectorVersion",
  "phaseModelVersion",
  "scoringModelVersion",
  "shotConfigVersion",
];
const SHOT_TYPES = [
  "drive",
  "dink",
  "serve",
  "café",
  "cafe\u0301",
  "\u212Bngstr\u00F6m",
  "x".repeat(64),
  "\u{1F3D3}".repeat(64),
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shotPayload(rng, { id, permitId, resultKind }) {
  const scored = resultKind === "scored";
  return {
    id,
    analysisPermitId: permitId,
    sessionId: null,
    shotType: rng.pick(SHOT_TYPES),
    cameraView: rng.pick(["side", "rear_oblique"]),
    capturedAt: new Date(
      Date.UTC(2026, rng.int(0, 11), rng.int(1, 28), rng.int(0, 23)),
    ).toISOString(),
    startMs: 0,
    contactMs: rng.pick([500, null, 0, 2147483647]),
    endMs: rng.pick([1000, 2147483647, 1]),
    overallScore: scored ? rng.pick([0, 10, 4.83, 9.995, 0.004]) : null,
    confidence: rng.pick([0, 1, 0.5315, 0.99995]),
    resultKind,
    phases: [
      {
        key: "backswing",
        startMs: 0,
        representativeMs: 200,
        endMs: 400,
        confidence: rng.pick([0.9, 1.5, -1]),
      },
    ],
    checkpoints: [
      {
        key: "paddle_prep",
        direction: "up",
        score: scored ? 7 : null,
        confidence: 0.7,
        band: "green",
        severity: 0.1,
        applicable: true,
      },
    ],
    versionVector: Object.fromEntries(
      VERSION_KEYS.map((k) => [
        k,
        rng.pick(["1", "1.0.0", "x".repeat(64), "caf\u00e9", "cafe\u0301"]),
      ]),
    ),
  };
}

// Boundary-malformed racer payloads: all must be rejected with a typed status
// or a 4xx-class SQLSTATE and must not write.
function malformedPayload(rng, ids) {
  const base = shotPayload(rng, { ...ids, resultKind: "scored" });
  const variant = rng.int(0, 7);
  if (variant === 0) return { text: JSON.stringify(base).slice(0, 40), why: "truncated json" };
  if (variant === 1)
    return { text: JSON.stringify({ ...base, shotType: "a\u0000b" }), why: "null byte" };
  if (variant === 2)
    return { text: JSON.stringify({ ...base, overallScore: "NaN" }), why: "NaN score" };
  if (variant === 3)
    return {
      text: JSON.stringify({ ...base, analysisPermitId: "../" + ids.permitId }),
      why: "traversal permit id",
    };
  if (variant === 4)
    return { text: JSON.stringify({ ...base, startMs: 2147483648 }), why: "int overflow" };
  if (variant === 5)
    return {
      text: JSON.stringify({ ...base, resultKind: "scored_v2" }),
      why: "future result kind",
    };
  if (variant === 6)
    return { text: JSON.stringify({ ...base, overallScore: null }), why: "scored without score" };
  return { text: JSON.stringify({ ...base, versionVector: {} }), why: "empty version vector" };
}

async function writerTxn(client, { uid, isolation }, body) {
  // A live authenticated write, as PostgREST would issue it.
  await client.query(`begin isolation level ${isolation}`);
  try {
    await asUser(client, uid);
    const result = await body(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

async function racing(rng, parts) {
  // parts: [{ name, run }] — each gets a seeded 0..12ms start delay so the
  // interleaving differs per seed; results are recorded per part.
  const delays = parts.map(() => rng.int(0, 12));
  const settled = await Promise.all(
    parts.map(async (p, i) => {
      await sleep(delays[i]);
      const t0 = performance.now();
      try {
        const value = await p.run();
        return {
          name: p.name,
          delay_ms: delays[i],
          ms: Math.round(performance.now() - t0),
          ok: true,
          value,
        };
      } catch (err) {
        return {
          name: p.name,
          delay_ms: delays[i],
          ms: Math.round(performance.now() - t0),
          ok: false,
          error: describeError(err),
        };
      }
    }),
  );
  return settled;
}

function pickIsolation(rng) {
  return rng.chance(0.3) ? "serializable" : "read committed";
}

// 40001 under SERIALIZABLE is the documented retryable outcome; it is not a
// violation as long as the invariant holds after the retry.
const isSerializationFailure = (part) => !part.ok && part.error?.code === "40001";

async function permitRow(admin, id) {
  const r = await admin.query(
    "select status, outcome, created_at from public.analysis_permits where id = $1",
    [id],
  );
  return r.rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
async function runIteration({ i, seed, admin, c1, c2, c3, sweeps }) {
  const rng = new Rng(seed);
  const scenario =
    REPLAY && process.env.STRESS_SCENARIO ? process.env.STRESS_SCENARIO : rng.pick(SCENARIOS);
  const isolation = pickIsolation(rng);
  const jitterMs = rng.pick([-30000, -5000, -1000, -100, -1, 0, 1, 100, 1000, 5000, 30000]);
  const uid = rng.chance(0.25) ? USERS.b : USERS.a; // B is premium (billing_entitlements), A is free
  const tag = `stress-${seed}`;
  const record = {
    i,
    seed,
    scenario,
    isolation,
    jitter_ms: jitterMs,
    actor: uid === USERS.a ? "a(free)" : "b(premium)",
    parts: [],
    final: {},
    problems: [],
  };
  const problems = record.problems;

  try {
    if (scenario.startsWith("permit.")) {
      // A reserved permit whose age straddles the 24h cutoff by jitterMs.
      const permitId = rng.uuid();
      const key = `${tag}-key`;
      await admin.query(
        "insert into public.analysis_permits (id, user_id, idempotency_key, status, created_at) values ($1, $2, $3, 'reserved', now() - interval '24 hours' + ($4::int * interval '1 millisecond'))",
        [permitId, uid, key, jitterMs],
      );
      const stale = jitterMs < 0; // strictly older than the cutoff at insert time
      const sweep = {
        name: "sweep.permits",
        run: async () => (await admin.query(sweeps["expire-stale-analysis-permits"])).rowCount,
      };

      if (scenario === "permit.stale_vs_apply" || scenario === "permit.stale_vs_apply_malformed") {
        const shotId = rng.uuid();
        const resultKind = rng.chance(0.3) ? "low_confidence" : "scored";
        const payload =
          scenario === "permit.stale_vs_apply"
            ? {
                text: JSON.stringify(shotPayload(rng, { id: shotId, permitId, resultKind })),
                why: "valid",
              }
            : malformedPayload(rng, { id: shotId, permitId });
        record.payload_why = payload.why;
        record.payload =
          payload.text.length > 600
            ? `${payload.text.slice(0, 600)}…(${payload.text.length} chars)`
            : payload.text;
        const writer = {
          name: "apply_synced_shot",
          run: () =>
            writerTxn(c1, { uid, isolation }, async (c) => {
              const r = await c.query("select public.apply_synced_shot($1::jsonb) as status", [
                payload.text,
              ]);
              return r.rows[0].status;
            }),
        };
        record.parts = await racing(rng, [sweep, writer]);
        let w = record.parts[1];
        if (isSerializationFailure(w)) {
          record.retry = await racing(rng, [writer]);
          w = record.retry[0];
        }
        const permit = await permitRow(admin, permitId);
        const shot = await admin.query(
          "select user_id, result_kind from public.shots where id = $1",
          [shotId],
        );
        record.final = { permit, shot_rows: shot.rowCount, writer: w.ok ? w.value : w.error };

        if (!w.ok) {
          const http = postgrestStatus(w.error.code);
          if (scenario === "permit.stale_vs_apply")
            problems.push(`writer threw ${w.error.code} (${w.error.message})`);
          else if (http >= 500)
            problems.push(`malformed racer produced 5xx-class SQLSTATE ${w.error.code}`);
          else record.note = `malformed racer rejected pre-function with ${w.error.code} (${http})`;
        }
        if (scenario === "permit.stale_vs_apply_malformed") {
          if (w.ok && w.value === "accepted") problems.push("malformed payload accepted");
          if (shot.rowCount !== 0) problems.push("malformed payload wrote a shot");
          if (w.ok && !/^(accepted|access\.|shot\.)/.test(String(w.value)))
            problems.push(`untyped status ${w.value}`);
        } else if (w.ok) {
          const status = w.value;
          if (status === "accepted") {
            if (shot.rowCount !== 1) problems.push("accepted without a shot row");
            if (permit.status !== (resultKind === "scored" ? "finalized" : "released"))
              problems.push(`accepted but permit ${permit.status}/${permit.outcome}`);
            if (permit.outcome === "expired") problems.push("accepted AND swept as expired");
            if (stale && jitterMs <= -1000)
              problems.push("stale permit (>=1s past cutoff) accepted a shot");
          } else {
            if (shot.rowCount !== 0) problems.push(`status ${status} but a shot row exists`);
            if (
              ![
                "access.permit_expired",
                "access.permit_not_reserved",
                "access.paywall_required",
              ].includes(status)
            )
              problems.push(`unexpected typed status ${status}`);
            if (status === "access.paywall_required" && uid === USERS.b)
              problems.push("premium user hit paywall");
            if (!stale && jitterMs >= 1000 && status !== "access.paywall_required")
              problems.push(`fresh permit (${jitterMs}ms before cutoff) rejected as ${status}`);
            if (permit.status === "reserved") problems.push("rejected but permit still reserved");
          }
        }
        if (shot.rowCount === 1 && permit.status === "released" && permit.outcome === "expired")
          problems.push("shot exists for an expired permit");
      } else if (scenario === "permit.stale_vs_reserve_same_key") {
        const writer = {
          name: "reserve_analysis_permit(same key)",
          run: () =>
            writerTxn(c1, { uid, isolation }, async (c) => {
              const r = await c.query("select * from public.reserve_analysis_permit($1)", [key]);
              return r.rows[0];
            }),
        };
        record.parts = await racing(rng, [sweep, writer]);
        let w = record.parts[1];
        if (isSerializationFailure(w)) {
          record.retry = await racing(rng, [writer]);
          w = record.retry[0];
        }
        const permit = await permitRow(admin, permitId);
        const count = await admin.query(
          "select count(*)::int as n from public.analysis_permits where user_id = $1 and idempotency_key = $2",
          [uid, key],
        );
        record.final = { permit, same_key_rows: count.rows[0].n, writer: w.ok ? w.value : w.error };
        if (!w.ok) problems.push(`reserve threw ${w.error.code}`);
        else {
          if (w.value.result !== "accepted")
            problems.push(`same-key replay result ${w.value.result}`);
          if (w.value.permit_id !== permitId)
            problems.push("same-key replay returned a different permit");
          if (!["reserved", "released"].includes(w.value.permit_status))
            problems.push(`replay status ${w.value.permit_status}`);
        }
        if (count.rows[0].n !== 1)
          problems.push(`idempotency key duplicated: ${count.rows[0].n} rows`);
        if (stale && jitterMs <= -1000 && permit.status !== "released")
          problems.push("sweep left a stale permit reserved");
      } else {
        // permit.stale_vs_reserve_new_key: the stale permit must not count
        // against the two fresh reservations; a free user never ends with >2
        // fresh reserved permits.
        const extra = rng.int(0, 2);
        for (let k = 0; k < extra; k += 1) {
          await admin.query(
            "insert into public.analysis_permits (user_id, idempotency_key, status) values ($1, $2, 'reserved')",
            [uid, `${tag}-fresh-${k}`],
          );
        }
        // Allowance as the RPC counts it right before the race (includes the
        // straddling permit while it is still inside the 24h window).
        const fresh = (
          await admin.query(
            "select count(*)::int as n from public.analysis_permits where user_id = $1 and status = 'reserved' and created_at > now() - interval '24 hours'",
            [uid],
          )
        ).rows[0].n;
        const writer = {
          name: "reserve_analysis_permit(new key)",
          run: () =>
            writerTxn(c1, { uid, isolation }, async (c) => {
              const r = await c.query("select * from public.reserve_analysis_permit($1)", [
                `${tag}-new`,
              ]);
              return r.rows[0];
            }),
        };
        const writer2 = {
          name: "reserve_analysis_permit(new key, 2nd conn)",
          run: () =>
            writerTxn(c2, { uid, isolation }, async (c) => {
              const r = await c.query("select * from public.reserve_analysis_permit($1)", [
                `${tag}-new2`,
              ]);
              return r.rows[0];
            }),
        };
        record.parts = await racing(rng, [sweep, writer, writer2]);
        for (const idx of [1, 2]) {
          if (isSerializationFailure(record.parts[idx])) {
            record.retry = record.retry ?? [];
            const again = await racing(rng, [idx === 1 ? writer : writer2]);
            record.retry.push(again[0]);
            record.parts[idx] = again[0];
          }
        }
        const freshReserved = await admin.query(
          "select count(*)::int as n from public.analysis_permits where user_id = $1 and status = 'reserved' and created_at > now() - interval '24 hours'",
          [uid],
        );
        const permit = await permitRow(admin, permitId);
        record.final = {
          permit,
          fresh_reserved: freshReserved.rows[0].n,
          writers: record.parts.slice(1).map((p) => (p.ok ? p.value?.result : p.error)),
        };
        for (const p of record.parts.slice(1)) {
          if (!p.ok) problems.push(`reserve threw ${p.error.code}`);
          else if (!["accepted", "access.paywall_required"].includes(p.value.result))
            problems.push(`untyped reserve result ${p.value.result}`);
          else if (p.value.result === "access.paywall_required" && uid === USERS.b)
            problems.push("premium user hit paywall");
        }
        const acceptedNow = record.parts
          .slice(1)
          .filter((p) => p.ok && p.value.result === "accepted").length;
        record.final.pre_existing_fresh = fresh;
        // Fixtures are inserted as superuser and may already exceed the
        // allowance; the RPC must never ADD a reservation past it.
        if (uid === USERS.a && freshReserved.rows[0].n > Math.max(2, fresh))
          problems.push(
            `free user holds ${freshReserved.rows[0].n} fresh reserved permits (had ${fresh})`,
          );
        if (uid === USERS.a && Math.abs(jitterMs) >= 1000 && acceptedNow > Math.max(0, 2 - fresh))
          problems.push(
            `free user accepted ${acceptedNow} reservations on top of ${fresh} fresh ones`,
          );
        if (
          uid === USERS.a &&
          Math.abs(jitterMs) >= 1000 &&
          fresh + acceptedNow < Math.min(2, fresh + 2)
        )
          problems.push("free user was refused a reservation inside its allowance");
        if (uid === USERS.b && acceptedNow !== 2)
          problems.push("premium user was refused a reservation");
        if (stale && jitterMs <= -1000 && permit.status !== "released")
          problems.push("sweep left the stale permit reserved");
      }
    } else if (scenario.startsWith("deletion.")) {
      // A deletion request whose expires_at straddles the 1-day purge cutoff.
      await admin.query(
        "insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at) values ($1, $2, now() - interval '1 day 15 minutes' + ($3::int * interval '1 millisecond'), now() - interval '1 day' + ($3::int * interval '1 millisecond')) on conflict (user_id) do update set challenge = excluded.challenge, created_at = excluded.created_at, expires_at = excluded.expires_at",
        [uid, rng.uuid(), jitterMs],
      );
      const purgeable = jitterMs < 0;
      const sweep = {
        name: "sweep.deletion_requests",
        run: async () => (await admin.query(sweeps["purge-expired-deletion-requests"])).rowCount,
      };
      if (scenario === "deletion.expiry_vs_upsert") {
        const challenge = rng.uuid();
        const writer = {
          name: "upsert deletion request (authenticated)",
          run: () =>
            writerTxn(c1, { uid, isolation }, async (c) => {
              // Exactly the PostgREST merge-duplicates shape the edge fn issues.
              const r = await c.query(
                `insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
                 values ($1, $2, now(), now() + interval '15 minutes')
                 on conflict (user_id) do update set challenge = excluded.challenge, created_at = excluded.created_at, expires_at = excluded.expires_at
                 returning challenge, expires_at`,
                [uid, challenge],
              );
              return r.rows[0];
            }),
        };
        record.parts = await racing(rng, [sweep, writer]);
        let w = record.parts[1];
        if (isSerializationFailure(w)) {
          record.retry = await racing(rng, [writer]);
          w = record.retry[0];
        }
        const row = await admin.query(
          "select challenge, expires_at > now() as live from public.account_deletion_requests where user_id = $1",
          [uid],
        );
        record.final = {
          rows: row.rowCount,
          challenge_matches: row.rows[0]?.challenge === challenge,
          live: row.rows[0]?.live ?? null,
          writer: w.ok ? "ok" : w.error,
        };
        if (!w.ok) problems.push(`upsert threw ${w.error.code} (${w.error.message})`);
        if (row.rowCount !== 1)
          problems.push(
            `expected exactly one deletion request after the race, found ${row.rowCount}`,
          );
        else if (row.rows[0].challenge !== challenge)
          problems.push("race lost the fresh challenge (stale row survived / fresh row purged)");
      } else {
        const reader = {
          name: "confirm-read (authenticated)",
          run: () =>
            writerTxn(c1, { uid, isolation }, async (c) => {
              const r = await c.query(
                "select challenge, created_at, expires_at from public.account_deletion_requests where user_id = $1",
                [uid],
              );
              return r.rowCount;
            }),
        };
        record.parts = await racing(rng, [sweep, reader]);
        const row = await admin.query(
          "select 1 from public.account_deletion_requests where user_id = $1",
          [uid],
        );
        record.final = {
          rows_after: row.rowCount,
          read_rows: record.parts[1].ok ? record.parts[1].value : record.parts[1].error,
        };
        if (!record.parts[1].ok) problems.push(`confirm-read threw ${record.parts[1].error.code}`);
        if (purgeable && jitterMs <= -1000 && row.rowCount !== 0)
          problems.push("purgeable deletion request survived the sweep");
        if (!purgeable && jitterMs >= 1000 && row.rowCount !== 1)
          problems.push("non-purgeable deletion request was purged");
      }
    } else if (scenario.startsWith("webhook.")) {
      // Old events straddling the 90-day cutoff, plus concurrent service inserts.
      const oldIds = Array.from({ length: rng.int(1, 5) }, (_, k) => `${tag}-old-${k}`);
      for (const id of oldIds) {
        await admin.query(
          "insert into public.webhook_events (id, provider, event_type, app_user_id, payload, received_at) values ($1, 'revenuecat', 'TEST', $2, '{}'::jsonb, now() - interval '90 days' + ($3::int * interval '1 millisecond'))",
          [id, uid, jitterMs],
        );
      }
      const purgeable = jitterMs < 0;
      const newId = scenario === "webhook.retention_vs_replayed_id" ? oldIds[0] : `${tag}-new`;
      const payload = JSON.stringify({
        event: {
          id: newId,
          type: "RENEWAL",
          app_user_id: uid,
          nested: { deep: "x".repeat(rng.pick([1, 2000, 65536])) },
        },
      });
      const sweep = {
        name: "sweep.webhook_events",
        run: async () => (await admin.query(sweeps["purge-old-webhook-events"])).rowCount,
      };
      const inserter = {
        name: "service insert webhook_event",
        run: async () => {
          await c3.query(`begin isolation level ${isolation}`);
          try {
            await asServiceRole(c3);
            const r = await c3.query(
              "insert into public.webhook_events (id, provider, event_type, app_user_id, payload) values ($1, 'revenuecat', 'RENEWAL', $2, $3::jsonb) on conflict (id) do nothing returning id",
              [newId, uid, payload],
            );
            await c3.query("commit");
            return r.rowCount;
          } catch (err) {
            await c3.query("rollback").catch(() => {});
            throw err;
          }
        },
      };
      // An authenticated client must see nothing in webhook_events regardless.
      const rlsProbe = {
        name: "authenticated select webhook_events",
        run: () =>
          writerTxn(c1, { uid, isolation }, async (c) => {
            const r = await c
              .query("select count(*)::int as n from public.webhook_events")
              .catch((e) => ({ denied: e.code }));
            return r.denied ? `denied:${r.denied}` : `rows:${r.rows[0].n}`;
          }),
      };
      record.parts = await racing(rng, [sweep, inserter, rlsProbe]);
      let ins = record.parts[1];
      if (isSerializationFailure(ins)) {
        record.retry = await racing(rng, [inserter]);
        ins = record.retry[0];
      }
      const remaining = await admin.query(
        "select id, received_at < now() - interval '90 days' as stale, received_at > now() - interval '1 minute' as inserted_now from public.webhook_events where id = any($1::text[])",
        [[...oldIds, newId]],
      );
      const newRow = remaining.rows.find((r) => r.id === newId);
      record.final = {
        inserted: ins.ok ? ins.value : ins.error,
        remaining: remaining.rows.map(
          (r) => `${r.id.slice(-6)}:${r.stale ? "stale" : r.inserted_now ? "new" : "kept"}`,
        ),
        rls: record.parts[2].ok ? record.parts[2].value : record.parts[2].error,
      };
      if (!ins.ok) problems.push(`service insert threw ${ins.error.code} (${ins.error.message})`);
      if (record.parts[2].ok && record.parts[2].value !== "denied:42501")
        problems.push(`authenticated role could read webhook_events: ${record.parts[2].value}`);
      if (scenario === "webhook.retention_vs_insert") {
        if (!newRow) problems.push("fresh event lost");
        else if (!newRow.inserted_now) problems.push("fresh event stored with a stale received_at");
      } else {
        // Replayed id: either the old row absorbed the replay (do nothing; the
        // sweep may then remove it) or the sweep won and the replay was stored.
        if (ins.ok && ins.value === 1 && !newRow)
          problems.push("replayed event inserted then vanished");
        if (ins.ok && ins.value === 1 && newRow && !newRow.inserted_now)
          problems.push("replay reported inserted but the old row survived");
        if (ins.ok && ins.value === 0 && newRow && newRow.inserted_now)
          problems.push("replay absorbed but a new row exists");
      }
      if (purgeable && jitterMs <= -1000) {
        const staleLeft = remaining.rows.filter((r) => r.stale);
        if (staleLeft.length > 0)
          problems.push(`stale events survived the sweep: ${staleLeft.length}`);
      }
      if (!purgeable && jitterMs >= 1000) {
        const kept = remaining.rows.filter((r) => oldIds.includes(r.id)).length;
        if (kept !== oldIds.length)
          problems.push(`events inside retention were purged (${kept}/${oldIds.length} kept)`);
      }
    } else {
      // sweeps.parallel_runners: two cron-like runners execute all three
      // statements at once (pg_cron can overlap a slow run with the next
      // tick) while live writes land on every swept table.
      const permitId = rng.uuid();
      await admin.query(
        "insert into public.analysis_permits (id, user_id, idempotency_key, status, created_at) values ($1, $2, $3, 'reserved', now() - interval '24 hours' + ($4::int * interval '1 millisecond'))",
        [permitId, uid, `${tag}-key`, jitterMs],
      );
      await admin.query(
        "insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at) values ($1, $2, now() - interval '2 days', now() - interval '1 day' + ($3::int * interval '1 millisecond')) on conflict (user_id) do update set challenge = excluded.challenge, created_at = excluded.created_at, expires_at = excluded.expires_at",
        [uid, rng.uuid(), jitterMs],
      );
      await admin.query(
        "insert into public.webhook_events (id, provider, event_type, app_user_id, payload, received_at) values ($1, 'revenuecat', 'TEST', $2, '{}'::jsonb, now() - interval '90 days' + ($3::int * interval '1 millisecond'))",
        [`${tag}-old-0`, uid, jitterMs],
      );
      const runAll = (client) => async () => {
        const out = [];
        for (const name of Object.keys(sweeps)) {
          const r = await client.query(sweeps[name]);
          out.push(`${name}:${r.rowCount}`);
        }
        return out;
      };
      const shotId = rng.uuid();
      const live = {
        name: "live writes",
        run: () =>
          writerTxn(c1, { uid, isolation }, async (c) => {
            const s = await c.query("select public.apply_synced_shot($1::jsonb) as status", [
              JSON.stringify(shotPayload(rng, { id: shotId, permitId, resultKind: "scored" })),
            ]);
            const d = await c.query(
              "insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at) values ($1, $2, now(), now() + interval '15 minutes') on conflict (user_id) do update set challenge = excluded.challenge, created_at = excluded.created_at, expires_at = excluded.expires_at",
              [uid, rng.uuid()],
            );
            return { shot: s.rows[0].status, deletion: d.rowCount };
          }),
      };
      record.parts = await racing(rng, [
        { name: "runner-1", run: runAll(admin) },
        { name: "runner-2", run: runAll(c2) },
        live,
      ]);
      if (isSerializationFailure(record.parts[2])) {
        record.retry = await racing(rng, [live]);
        record.parts[2] = record.retry[0];
      }
      const permit = await permitRow(admin, permitId);
      const shot = await admin.query("select 1 from public.shots where id = $1", [shotId]);
      const del = await admin.query(
        "select 1 from public.account_deletion_requests where user_id = $1",
        [uid],
      );
      record.final = {
        permit,
        shot_rows: shot.rowCount,
        deletion_rows: del.rowCount,
        live: record.parts[2].ok ? record.parts[2].value : record.parts[2].error,
      };
      for (const p of record.parts.slice(0, 2))
        if (!p.ok) problems.push(`sweep runner failed ${p.error.code} (${p.error.message})`);
      if (!record.parts[2].ok) problems.push(`live writer threw ${record.parts[2].error.code}`);
      if (shot.rowCount === 1 && permit.status !== "finalized")
        problems.push(`shot exists but permit ${permit.status}/${permit.outcome}`);
      if (shot.rowCount === 0 && permit.status === "finalized")
        problems.push("permit finalized without a shot");
      if (del.rowCount !== 1) problems.push(`deletion request rows after race: ${del.rowCount}`);
    }
  } catch (err) {
    record.harness_error = describeError(err);
    record.harness_stack = String(err.stack ?? "")
      .split("\n")
      .slice(0, 4)
      .join("\n");
  } finally {
    // Cleanup: every row this iteration created; the free-rating ledger is
    // reset so user A stays a two-free-ratings account across iterations.
    for (const c of [c1, c2, c3]) await c.query("rollback").catch(() => {});
    await admin.query("delete from public.shots where user_id = any($1::uuid[])", [
      [USERS.a, USERS.b],
    ]);
    await admin.query("delete from public.analysis_permits where user_id = any($1::uuid[])", [
      [USERS.a, USERS.b],
    ]);
    await admin.query(
      "delete from public.account_deletion_requests where user_id = any($1::uuid[])",
      [[USERS.a, USERS.b]],
    );
    await admin.query("delete from public.webhook_events where id like $1", [`${tag}-%`]);
    await admin.query("delete from public.free_rating_ledger");
  }
  record.verdict = record.harness_error ? "HARNESS_ERROR" : problems.length ? "BROKEN" : "HELD";
  return record;
}

async function main() {
  const admin = await connect();
  const c1 = await connect();
  const c2 = await connect();
  const c3 = await connect();
  await seedUsers(admin);
  await admin.query(
    "insert into public.billing_entitlements (user_id, premium, product_key) values ($1, true, 'pickle_sensei_pro_lifetime') on conflict (user_id) do update set premium = true, expires_at = null",
    [USERS.b],
  );
  const { source, sweeps, pgCron } = await loadSweeps(admin);
  const cronJobs = pgCron
    ? (await admin.query("select jobname, schedule, active from cron.job order by jobname")).rows
    : [];

  const seeds =
    REPLAY !== null
      ? [REPLAY]
      : Array.from({ length: ITER }, (_, i) => iterationSeed(CAMPAIGN_SEED, i));
  const results = [];
  const t0 = performance.now();
  for (let i = 0; i < seeds.length; i += 1) {
    const rec = await runIteration({
      i: REPLAY !== null ? -1 : i,
      seed: seeds[i],
      admin,
      c1,
      c2,
      c3,
      sweeps,
    });
    results.push(rec);
    if (REPLAY !== null) console.log(JSON.stringify(rec, null, 2));
  }
  const elapsed = Math.round(performance.now() - t0);

  const summary = {
    campaign: "sweep-races",
    campaign_seed: CAMPAIGN_SEED,
    iterations: results.length,
    elapsed_ms: elapsed,
    sweep_source: source,
    cron_jobs: cronJobs,
    verdicts: {},
    scenarios: {},
    isolation: {},
    serialization_retries: results.filter((r) => r.retry).length,
    problems: {},
    broken_seeds: results
      .filter((r) => r.verdict !== "HELD")
      .map((r) => ({
        seed: r.seed,
        scenario: r.scenario,
        problems: r.problems,
        harness_error: r.harness_error,
      })),
  };
  for (const r of results) {
    summary.verdicts[r.verdict] = (summary.verdicts[r.verdict] ?? 0) + 1;
    summary.scenarios[r.scenario] = (summary.scenarios[r.scenario] ?? 0) + 1;
    summary.isolation[r.isolation] = (summary.isolation[r.isolation] ?? 0) + 1;
    for (const p of r.problems) summary.problems[p] = (summary.problems[p] ?? 0) + 1;
  }

  await admin.query("delete from public.billing_entitlements where user_id = $1", [USERS.b]);
  for (const c of [admin, c1, c2, c3]) await c.end();

  const dir = path.join(
    OUT_DIR,
    REPLAY !== null ? `sweeps-replay-${REPLAY}` : `sweeps-${CAMPAIGN_SEED}-${results.length}`,
  );
  const seedFile = writeJson(dir, "seed_outcomes.json", results);
  const summaryFile = writeJson(dir, "summary.json", summary);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`seed table: ${seedFile}\nsummary: ${summaryFile}`);
  process.exitCode = summary.verdicts.BROKEN || summary.verdicts.HARNESS_ERROR ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
