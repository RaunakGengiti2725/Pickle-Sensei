/**
 * stress_shots_sync_concurrency — seeded concurrency stress campaign for
 * POST /v1/shots:sync against the REAL edge handler (../index.ts) with the
 * modelled Supabase/GoTrue/RevenueCat/Upstash from xc_concurrency_harness.ts.
 *
 * Scenario kinds, invariants and the seed → outcome report are in
 * stress_shots_sync_common.ts. Knobs:
 *
 *   STRESS_ITER=520            iterations (default 40 — every kind ≥ 2×)
 *   STRESS_SEED=20260905       campaign seed
 *   STRESS_REPLAY=17,42        re-run exactly those iteration indexes
 *   STRESS_ONLY=<kind>         restrict the deck to one scenario kind
 *   STRESS_LATENCY_MS=6        max seeded latency per modelled upstream call
 *   STRESS_OUT_DIR=…           report directory (default
 *                              artifacts/stress-shots-sync/latest/)
 *
 *   deno test --allow-all --no-check stress_shots_sync_concurrency.test.ts
 */
import { assertEquals } from "@std/assert";
import { loadXcHarness } from "./xc_concurrency_harness.ts";
import {
  runCampaign,
  type Snapshot,
  STRESS_ITER,
  STRESS_SEED,
  type StressBackend,
} from "./stress_shots_sync_common.ts";

const IP_OCTET = 77;

function fakeBackend(h: Awaited<ReturnType<typeof loadXcHarness>>): StressBackend {
  const fake = h.fake;
  return {
    name: "fake",
    prepareUser: () => Promise.resolve(),
    forgePermit: (userId, key, createdAtOffsetMs = 0) => {
      const id = fake.prng.uuid();
      fake.tables.analysis_permits.push({
        id,
        user_id: userId,
        idempotency_key: key,
        status: "reserved",
        outcome: null,
        created_at: new Date(Date.now() + createdAtOffsetMs).toISOString(),
      });
      return Promise.resolve(id);
    },
    setPermitCreatedAt: (permitId, createdAtOffsetMs) => {
      const row = fake.tables.analysis_permits.find((p) => p.id === permitId);
      if (!row) throw new Error(`permit ${permitId} not found`);
      row.created_at = new Date(Date.now() + createdAtOffsetMs).toISOString();
      return Promise.resolve();
    },
    setPremium: (userId, expiresAt) => {
      fake.tables.billing_entitlements = fake.tables.billing_entitlements.filter(
        (b) => b.user_id !== userId,
      );
      fake.tables.billing_entitlements.push({
        user_id: userId,
        premium: true,
        expires_at: expiresAt,
        product_key: "pickle_sensei_pro_monthly",
        verified_at: new Date().toISOString(),
      });
      return Promise.resolve();
    },
    createSession: (userId, sessionId) => {
      fake.tables.sessions.push({ id: sessionId, user_id: userId });
      return Promise.resolve();
    },
    snapshot: (userIds) => {
      const users = new Set(userIds);
      const ledger: Record<string, number> = {};
      for (const uid of userIds) {
        const user = fake.users.get(uid);
        ledger[uid] = user ? (fake.identityLedger.get(`${user.provider}:${uid}`) ?? 0) : 0;
      }
      const snap: Snapshot = {
        shots: fake.tables.shots
          .filter((s) => users.has(String(s.user_id)))
          .map((s) => ({
            id: String(s.id),
            userId: String(s.user_id),
            resultKind: String(s.result_kind),
          })),
        permits: fake.tables.analysis_permits
          .filter((p) => users.has(String(p.user_id)))
          .map((p) => ({
            id: String(p.id),
            userId: String(p.user_id),
            status: String(p.status),
            outcome: p.outcome === null || p.outcome === undefined ? "" : String(p.outcome),
          })),
        ledger,
      };
      return Promise.resolve(snap);
    },
  };
}

Deno.test(
  `stress: POST /v1/shots:sync concurrency campaign (fake backend, ${STRESS_ITER} seeded interleavings)`,
  async () => {
    const h = await loadXcHarness();
    const summary = await runCampaign(
      h,
      fakeBackend(h),
      IP_OCTET,
      (index) =>
        `cd supabase/functions/api/__wf__ && STRESS_SEED=${STRESS_SEED} STRESS_REPLAY=${index} ` +
        `deno test --allow-all --no-check stress_shots_sync_concurrency.test.ts`,
      "stress_shots_sync_fake",
    );
    const notHeld = summary.iterations.filter((r) => r.outcome !== "HELD");
    assertEquals(
      notHeld.map((r) => ({
        index: r.index,
        seed: r.seed,
        kind: r.kind,
        outcome: r.outcome,
        notHeld: r.invariants.filter((i) => !i.holds).map((i) => `${i.name}: ${i.detail}`),
        replay: r.replay,
      })),
      [],
      `${notHeld.length}/${summary.iterationsExecuted} iterations did not hold`,
    );
  },
);
