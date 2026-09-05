/**
 * stress · route-post-v1-billing-sync · lens=concurrency
 *
 * Drives the REAL edge handler (index.ts, loaded in-process by
 * xc_concurrency_harness.ts with Supabase Auth / PostgREST / RevenueCat
 * modelled and Upstash absent) with seeded Promise.all bursts against
 * POST /v1/billing/sync:
 *
 *   dup_burst           duplicate calls for one user, stable RevenueCat truth
 *   rate_limit_burst    > 10 concurrent calls → exactly 10 admitted, 429 rest
 *   verdict_flip        call-during-call where RevenueCat's answer changes
 *                       between the overlapping verifications (lost-update
 *                       probe — timing-dependent, so the stale-overwrite rate
 *                       is RECORDED per campaign; the hard pin is below)
 *   stale_write_lands_last  deterministic lost-update pin: two overlapping
 *                       syncs, RevenueCat flips between them, the OLDER
 *                       verdict's upsert reaches the database LAST — the
 *                       row must still hold the fresher verdict
 *   sync_vs_webhook     two actors (billing sync + RevenueCat webhook) on the
 *                       same billing_entitlements row
 *   logout_during_sync  session revoked while syncs are in flight
 *   rotation_during_sync refresh-token rotation while syncs are in flight
 *   clock_skew          expires_date within ±δ ms of now / malformed dates
 *   rc_failure_abort    RevenueCat 5xx for some lanes + client aborts mid-call
 *   cross_user          two users' bursts interleaved — rows never cross
 *   free_rating_spend   syncs interleaved with permit reservations for a user
 *                       whose two lifetime ratings are spent — no double spend
 *
 * Every iteration is one seeded interleaving (fresh user, fresh IPs, fresh
 * fake state, seeded latency and seeded burst shape) and is replayable from
 * its seed. Results are written as a JSON table (seed → outcome) under
 * STRESS_OUT_DIR (default artifacts/stress-billing-sync/latest/).
 *
 *   STRESS_ITER=6      iterations per scenario (small default: ~10s total)
 *   STRESS_SEED        campaign seed (default 20260905)
 *   STRESS_LATENCY_MS  max modelled upstream latency per hop (default 8)
 *   STRESS_DEADLINE_MS bounded wall time per iteration (default 5000) — a
 *                      breach is reported as a deadlock/hang, never waited out
 *   STRESS_ONLY=verdict_flip   run one scenario
 *   STRESS_REPLAY=<seed>       replay exactly one iteration seed (with STRESS_ONLY)
 *
 *   cd supabase/functions/api/__wf__ && STRESS_ITER=60 deno test -A --no-check \
 *     --config deno.json stress_billing_sync_concurrency.test.ts
 */
import { assert } from "@std/assert";
import {
  bootstrap,
  edgeRequest,
  envInt,
  histogram,
  loadXcHarness,
  Prng,
  readJson,
  sleep,
  SUPABASE_URL,
  webhookRequest,
  type XcHarness,
} from "./xc_concurrency_harness.ts";

const STRESS_ITER = envInt("STRESS_ITER", 6);
const STRESS_SEED = envInt("STRESS_SEED", 20260905);
const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 8);
const STRESS_DEADLINE_MS = envInt("STRESS_DEADLINE_MS", 5000);
const STRESS_ONLY = Deno.env.get("STRESS_ONLY") ?? "";
const STRESS_REPLAY = Deno.env.get("STRESS_REPLAY") ?? "";

// ── seeds, ids, addressing ───────────────────────────────────────────────────

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Iteration seed: campaign seed × scenario × index — stable under STRESS_ONLY. */
function iterationSeed(scenario: string, i: number): number {
  return (fnv1a(`${STRESS_SEED}:${scenario}:${i}`) ^
    Math.imul(i + 1, 0x9e3779b1)) >>> 0;
}

const SCENARIOS = [
  "dup_burst",
  "rate_limit_burst",
  "verdict_flip",
  "stale_write_lands_last",
  "sync_vs_webhook",
  "logout_during_sync",
  "rotation_during_sync",
  "clock_skew",
  "rc_failure_abort",
  "cross_user",
  "free_rating_spend",
] as const;
type ScenarioName = (typeof SCENARIOS)[number];

/** Per-(scenario, iteration, lane) source address: the edge fn's in-memory
 * per-IP / auth-failure windows outlive fake.reset(), so no two iterations
 * may share an address (172.16/12 — disjoint from the xc matrix's 10/8). */
function ipFor(
  scenario: ScenarioName,
  iteration: number,
  lane: number,
): string {
  const s = SCENARIOS.indexOf(scenario);
  const hi = 16 + ((s * 13 + (iteration >> 8)) & 15);
  return `172.${hi}.${((iteration >> 4) & 15) * 16 + (lane & 15)}.${
    iteration & 255
  }`;
}

// ── RevenueCat truth shapes ──────────────────────────────────────────────────

interface Truth {
  premium: boolean;
  expiresAt: string | null;
  product: string;
}

function subscriberFor(truth: Truth): Record<string, unknown> {
  if (!truth.premium) return { entitlements: {} };
  return {
    entitlements: {
      pickle_sensei_pro: {
        expires_date: truth.expiresAt,
        product_identifier: truth.product,
      },
    },
  };
}

function randomTruth(prng: Prng): Truth {
  const premium = prng.next() < 0.5;
  if (!premium) {
    return {
      premium: false,
      expiresAt: null,
      product: "pickle_sensei_pro_monthly",
    };
  }
  const lifetime = prng.next() < 0.3;
  return {
    premium: true,
    expiresAt: lifetime
      ? null
      : new Date(Date.now() + 3_600_000 + prng.int(0, 86_400_000))
        .toISOString(),
    product: lifetime
      ? "pickle_sensei_pro_lifetime"
      : "pickle_sensei_pro_monthly",
  };
}

// ── outcome rows ─────────────────────────────────────────────────────────────

interface Lane {
  lane: number;
  op: string;
  status: number;
  code?: string;
  startedAt: number;
  endedAt: number;
  body: Record<string, unknown>;
}

interface Check {
  name: string;
  holds: boolean;
  detail: string;
  /** soft checks are reported, never fail the run (observations, not invariants) */
  soft?: boolean;
}

interface IterationOutcome {
  scenario: ScenarioName;
  iteration: number;
  seed: number;
  user: string;
  shape: Record<string, unknown>;
  statuses: Record<string, number>;
  checks: Check[];
  broken: string[];
  observations: Record<string, unknown>;
  rcCalls: number;
  durationMs: number;
  deadlockSuspected: boolean;
  replay: string;
}

/** One service-role write to billing_entitlements, captured on the wire
 * (before the modelled PostgREST applies it) so the persisted row can be
 * compared with the FULL set of verdicts that were written, not only the
 * ones a client was told about. */
interface BillingWrite {
  user: string;
  premium: boolean;
  expiresAt: string | null;
  verifiedAt: string;
  /** wall-clock moment the (modelled) database acknowledged the write — the
   * order in which the upserts were applied */
  arrivedAt: number;
}

const billingWrites: BillingWrite[] = [];
let writeTapInstalled = false;
/** Per-iteration hook: extra database-side latency (ms) for one upsert,
 * chosen from its payload — how a scenario pins the ORDER in which racing
 * writes reach the row (a slow PostgREST hop for one request). */
let writeDelayMs:
  | ((write: Omit<BillingWrite, "arrivedAt">) => number)
  | undefined;

function payloadWrites(raw: string): Array<Omit<BillingWrite, "arrivedAt">> {
  try {
    const parsed = JSON.parse(raw);
    const out: Array<Omit<BillingWrite, "arrivedAt">> = [];
    for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
      if (row && typeof row === "object") {
        const r = row as Record<string, unknown>;
        out.push({
          user: String(r.user_id),
          premium: Boolean(r.premium),
          expiresAt: typeof r.expires_at === "string" ? r.expires_at : null,
          verifiedAt: String(r.verified_at),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Wrap the harness's fetch once: record every billing_entitlements upsert
 * payload (after the modelled database acknowledged it), optionally holding
 * one write back per `writeDelayMs`, then hand the request on untouched. */
function installWriteTap(): void {
  if (writeTapInstalled) return;
  writeTapInstalled = true;
  const inner = globalThis.fetch;
  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const method = init?.method ??
      (input instanceof Request ? input.method : "GET");
    if (
      method !== "POST" ||
      !url.startsWith(`${SUPABASE_URL}/rest/v1/billing_entitlements`)
    ) {
      return inner(input, init);
    }
    const raw = typeof init?.body === "string"
      ? init.body
      : input instanceof Request
      ? await input.clone().text()
      : "";
    const writes = payloadWrites(raw);
    const hold = Math.max(0, ...writes.map((w) => writeDelayMs?.(w) ?? 0));
    if (hold > 0) await sleep(hold);
    const response = await inner(input, init);
    if (response.ok) {
      for (const w of writes) {
        billingWrites.push({ ...w, arrivedAt: performance.now() });
      }
    }
    return response;
  };
}

interface Ctx {
  h: XcHarness;
  prng: Prng;
  scenario: ScenarioName;
  iteration: number;
  seed: number;
  lanes: Lane[];
  checks: Check[];
  shape: Record<string, unknown>;
  observations: Record<string, unknown>;
  /** the verdicts RevenueCat served, in the order it answered */
  rcServed: Array<{ premium: boolean; expiresAt: string | null; user: string }>;
}

function writesFor(user: string): BillingWrite[] {
  return billingWrites.filter((w) => w.user === user);
}

/** The write with the newest verified_at — what the row MUST hold if no
 * update was lost (a stale verdict must never overwrite a fresher one). */
function freshestWrite(user: string): BillingWrite | undefined {
  return writesFor(user).slice().sort((a, b) =>
    a.verifiedAt.localeCompare(b.verifiedAt) || a.arrivedAt - b.arrivedAt
  ).at(-1);
}

/** Hard lost-update probe shared by every scenario that writes the row. */
function checkNoLostUpdate(ctx: Ctx, user: string, soft = false): void {
  const rows = billingRows(ctx, user);
  const row = rows[0];
  const writes = writesFor(user);
  const freshest = freshestWrite(user);
  const lastArrived = writes.slice().sort((a, b) => a.arrivedAt - b.arrivedAt)
    .at(-1);
  ctx.observations.writes = writes.map((w) => ({
    premium: w.premium,
    verifiedAt: w.verifiedAt,
    arrivedAt: Math.round(w.arrivedAt * 100) / 100,
  }));
  ctx.observations.row = row ?? null;
  const staleOverwrites =
    writes.filter((w) =>
      writes.some((o) =>
        o.verifiedAt > w.verifiedAt && o.arrivedAt < w.arrivedAt
      )
    ).length;
  ctx.observations.staleOverwrites = staleOverwrites;
  if (writes.length === 0) return;
  check(
    ctx,
    "row == last write to ARRIVE (upsert is last-writer-wins, nothing else)",
    row !== undefined && lastArrived !== undefined &&
      row.verified_at === lastArrived.verifiedAt &&
      Boolean(row.premium) === lastArrived.premium,
    `row=${JSON.stringify(row ?? null)} lastArrived=${
      JSON.stringify(lastArrived)
    }`,
  );
  check(
    ctx,
    "no lost update: row holds the write with the NEWEST verified_at (a stale verdict never overwrote a fresher one)",
    row !== undefined && freshest !== undefined &&
      row.verified_at === freshest.verifiedAt &&
      Boolean(row.premium) === freshest.premium &&
      (row.expires_at ?? null) === freshest.expiresAt,
    `row={premium:${row?.premium}, verified_at:${row?.verified_at}} freshest={premium:${freshest?.premium}, verifiedAt:${freshest?.verifiedAt}} writes=${writes.length} staleOverwrites=${staleOverwrites}`,
    soft,
  );
}

function check(
  ctx: Ctx,
  name: string,
  holds: boolean,
  detail: string,
  soft = false,
): void {
  ctx.checks.push({ name, holds, detail, soft });
}

async function call(
  ctx: Ctx,
  lane: number,
  op: string,
  request: Request,
): Promise<Lane> {
  const startedAt = performance.now();
  const response = await ctx.h.handler(request);
  const body = await readJson(response);
  const err = body.error;
  const nested = err && typeof err === "object"
    ? (err as Record<string, unknown>).code
    : undefined;
  const code = typeof nested === "string"
    ? nested
    : typeof body.code === "string"
    ? body.code
    : undefined;
  const row: Lane = {
    lane,
    op,
    status: response.status,
    code,
    startedAt: Math.round(startedAt * 100) / 100,
    endedAt: Math.round(performance.now() * 100) / 100,
    body,
  };
  ctx.lanes.push(row);
  return row;
}

function syncRequest(token: string, ip: string, signal?: AbortSignal): Request {
  const base = edgeRequest("POST", "/v1/billing/sync", { token, ip, body: {} });
  return signal ? new Request(base, { signal }) : base;
}

function billingRows(ctx: Ctx, user: string): Array<Record<string, unknown>> {
  return ctx.h.fake.tables.billing_entitlements.filter((b) =>
    b.user_id === user
  );
}

function billingOf(
  lane: Lane,
): { premium: boolean; verifiedAt: string; expiresAt: string | null } | null {
  const b = lane.body.billing;
  if (!b || typeof b !== "object") return null;
  const r = b as Record<string, unknown>;
  return {
    premium: Boolean(r.premium),
    verifiedAt: String(r.verifiedAt ?? ""),
    expiresAt: typeof r.expiresAt === "string" ? r.expiresAt : null,
  };
}

function accessOf(lane: Lane): Record<string, unknown> | null {
  const a = lane.body.access;
  return a && typeof a === "object" ? (a as Record<string, unknown>) : null;
}

/** Install a RevenueCat truth that may change per served call. */
function installRevenueCat(
  ctx: Ctx,
  truthFor: (callIndex: number, user: string) => Truth | null,
) {
  let n = 0;
  ctx.h.fake.overrides.subscriber = (user) => {
    const truth = truthFor(n++, user);
    if (!truth) return null;
    ctx.rcServed.push({
      premium: truth.premium,
      expiresAt: truth.expiresAt,
      user,
    });
    return subscriberFor(truth);
  };
  ctx.h.fake.overrides.rcDelayMs = () => ctx.prng.int(0, STRESS_LATENCY_MS * 2);
}

/** Common per-iteration checks on a burst of syncs for one user whose
 * RevenueCat truth did not change during the burst. */
function checkStableBurst(ctx: Ctx, user: string, truth: Truth, syncs: Lane[]) {
  const rows = billingRows(ctx, user);
  const ok = syncs.filter((s) => s.status === 200);
  check(
    ctx,
    "no 5xx",
    syncs.every((s) => s.status < 500),
    JSON.stringify(
      histogram(syncs.map((s) => `${s.status}${s.code ? `:${s.code}` : ""}`)),
    ),
  );
  check(
    ctx,
    "at most one billing row (upsert on user_id)",
    rows.length <= 1,
    `rows=${rows.length}`,
  );
  if (ok.length > 0) {
    check(
      ctx,
      "exactly one billing row after ≥1 success",
      rows.length === 1,
      `rows=${rows.length}`,
    );
    check(
      ctx,
      "row equals RevenueCat truth (premium, expires_at)",
      rows.length === 1 && Boolean(rows[0].premium) === truth.premium &&
        (rows[0].expires_at ?? null) === truth.expiresAt,
      `row=${JSON.stringify(rows[0] ?? null)} truth=${JSON.stringify(truth)}`,
    );
    check(
      ctx,
      "every 200 response: billing.premium == access.premium == truth",
      ok.every((s) => {
        const b = billingOf(s);
        const a = accessOf(s);
        return b !== null && a !== null && b.premium === truth.premium &&
          a.premium === truth.premium;
      }),
      histogramOf(
        ok.map((s) => `${billingOf(s)?.premium}/${accessOf(s)?.premium}`),
      ),
    );
    // With a stable truth an out-of-order write is content-identical: only
    // verified_at regresses. Reported as an observation, not an invariant.
    checkNoLostUpdate(ctx, user, true);
  }
}

function histogramOf(values: string[]): string {
  return JSON.stringify(histogram(values));
}

/** Bounded wall time: the iteration body races a deadline; a breach is a
 * deadlock/hang finding, and the campaign moves on instead of waiting. */
async function bounded<T>(
  fn: () => Promise<T>,
): Promise<{ value: T | null; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), STRESS_DEADLINE_MS);
  });
  try {
    const raced = await Promise.race([
      fn().then((value) => ({ value })),
      deadline,
    ]);
    if (raced === "timeout") return { value: null, timedOut: true };
    return { value: raced.value, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

// ── scenario bodies ──────────────────────────────────────────────────────────

type Body = (
  ctx: Ctx,
  user: string,
  token: string,
  refreshToken: string,
) => Promise<void>;

const bodies: Record<ScenarioName, Body> = {
  async dup_burst(ctx, user, token) {
    const k = ctx.prng.int(2, 10);
    const truth = randomTruth(ctx.prng);
    ctx.shape = { k, truth };
    installRevenueCat(ctx, () => truth);
    const syncs = await Promise.all(
      Array.from(
        { length: k },
        (_, i) =>
          call(
            ctx,
            i,
            "sync",
            syncRequest(token, ipFor(ctx.scenario, ctx.iteration, 1)),
          ),
      ),
    );
    check(
      ctx,
      "every duplicate call is 200 (≤10 within the budget)",
      syncs.every((s) => s.status === 200),
      histogramOf(syncs.map((s) => String(s.status))),
    );
    checkStableBurst(ctx, user, truth, syncs);
    check(
      ctx,
      "each call verified against RevenueCat exactly once",
      ctx.rcServed.length === k,
      `rc served=${ctx.rcServed.length} k=${k}`,
    );
  },

  async rate_limit_burst(ctx, user, token) {
    const extra = ctx.prng.int(1, 8);
    const k = 10 + extra;
    const truth = randomTruth(ctx.prng);
    ctx.shape = { k, extra, truth };
    installRevenueCat(ctx, () => truth);
    const syncs = await Promise.all(
      Array.from(
        { length: k },
        (_, i) =>
          call(
            ctx,
            i,
            "sync",
            syncRequest(token, ipFor(ctx.scenario, ctx.iteration, 1 + (i & 3))),
          ),
      ),
    );
    const admitted = syncs.filter((s) => s.status === 200);
    const limited = syncs.filter((s) => s.status === 429);
    check(
      ctx,
      "exactly 10 admitted, the rest 429 (atomic per-user billing_sync window)",
      admitted.length === 10 && limited.length === extra,
      `200=${admitted.length} 429=${limited.length} other=${
        syncs.length - admitted.length - limited.length
      }`,
    );
    check(
      ctx,
      "rejected calls never reached RevenueCat",
      ctx.rcServed.length === admitted.length,
      `rc served=${ctx.rcServed.length} admitted=${admitted.length}`,
    );
    checkStableBurst(ctx, user, truth, syncs);
  },

  async verdict_flip(ctx, user, token) {
    const k = ctx.prng.int(2, 8);
    const flipAt = ctx.prng.int(1, k - 1);
    const before = randomTruth(ctx.prng);
    const after: Truth = before.premium
      ? { premium: false, expiresAt: null, product: before.product }
      : {
        premium: true,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        product: "pickle_sensei_pro_monthly",
      };
    ctx.shape = { k, flipAt, before, after };
    // RevenueCat answers the first `flipAt` verifications with `before`, then
    // `after` (a purchase/refund lands between two overlapping syncs).
    installRevenueCat(ctx, (n) => (n < flipAt ? before : after));
    const syncs = await Promise.all(
      Array.from(
        { length: k },
        (_, i) =>
          call(
            ctx,
            i,
            "sync",
            syncRequest(token, ipFor(ctx.scenario, ctx.iteration, 1)),
          ),
      ),
    );
    const ok = syncs.filter((s) => s.status === 200);
    const rows = billingRows(ctx, user);
    check(
      ctx,
      "every call is 200",
      syncs.every((s) => s.status === 200),
      histogramOf(syncs.map((s) => String(s.status))),
    );
    check(
      ctx,
      "exactly one billing row",
      rows.length === 1,
      `rows=${rows.length}`,
    );
    const row = rows[0];
    ctx.observations = {
      rowPremium: row?.premium,
      rcServed: ctx.rcServed.map((r) => r.premium),
      responsesPremium: ok.map((s) => billingOf(s)?.premium),
    };
    // Whether the stale verdict's upsert lands last here depends on timer
    // resolution — recorded as a soft violation (the campaign reports the
    // rate); stale_write_lands_last pins the same invariant deterministically.
    checkNoLostUpdate(ctx, user, true);
    check(
      ctx,
      "row is not torn (premium/expires_at pair came from one verdict)",
      row !== undefined &&
        ((Boolean(row.premium) === before.premium &&
          (row.expires_at ?? null) === before.expiresAt) ||
          (Boolean(row.premium) === after.premium &&
            (row.expires_at ?? null) === after.expiresAt)),
      `row=${JSON.stringify(row ?? null)}`,
    );
    check(
      ctx,
      "each response reports the verdict its own verification saw",
      ok.every((s) => {
        const b = billingOf(s)!;
        return b.premium
          ? (b.expiresAt === (before.premium ? before : after).expiresAt)
          : b.expiresAt === null;
      }),
      histogramOf(ok.map((s) => String(billingOf(s)?.premium))),
    );
  },

  async sync_vs_webhook(ctx, user, token) {
    const k1 = ctx.prng.int(1, 5);
    const k2 = ctx.prng.int(1, 5);
    const flip = ctx.prng.next() < 0.5;
    const before = randomTruth(ctx.prng);
    const after: Truth = flip
      ? before.premium
        ? { premium: false, expiresAt: null, product: before.product }
        : {
          premium: true,
          expiresAt: null,
          product: "pickle_sensei_pro_lifetime",
        }
      : before;
    const flipAt = flip
      ? ctx.prng.int(1, k1 + k2 - 1)
      : Number.POSITIVE_INFINITY;
    const eventId = `evt-${ctx.seed}-${ctx.prng.uuid()}`;
    const type = after.premium ? "INITIAL_PURCHASE" : "EXPIRATION";
    ctx.shape = { k1, k2, flip, flipAt, before, after, eventId, type };
    installRevenueCat(ctx, (n) => (n < flipAt ? before : after));
    const lanes = ctx.prng.shuffle([
      ...Array.from(
        { length: k1 },
        (_, i) => () =>
          call(
            ctx,
            i,
            "sync",
            syncRequest(token, ipFor(ctx.scenario, ctx.iteration, 1)),
          ),
      ),
      ...Array.from({ length: k2 }, (_, i) => () =>
        call(
          ctx,
          k1 + i,
          "webhook",
          webhookRequest(
            {
              id: eventId,
              type,
              app_user_id: user,
              product_id: before.product,
            },
            { ip: ipFor(ctx.scenario, ctx.iteration, 2) },
          ),
        )),
    ]);
    const all = await Promise.all(lanes.map((fn) => fn()));
    const syncs = all.filter((l) => l.op === "sync");
    const hooks = all.filter((l) => l.op === "webhook");
    const rows = billingRows(ctx, user);
    const audit = ctx.h.fake.tables.webhook_events.filter((e) =>
      e.id === eventId
    );
    check(
      ctx,
      "every sync and every webhook copy is 200",
      all.every((l) => l.status === 200),
      histogramOf(all.map((l) => `${l.op}:${l.status}`)),
    );
    check(
      ctx,
      "exactly one billing row",
      rows.length === 1,
      `rows=${rows.length}`,
    );
    check(
      ctx,
      "exactly one webhook audit row",
      audit.length === 1,
      `rows=${audit.length}`,
    );
    ctx.observations = {
      rowPremium: rows[0]?.premium,
      rcServed: ctx.rcServed.map((r) => r.premium),
      syncPremium: syncs.map((s) => billingOf(s)?.premium),
      webhookVerified: hooks.map((w) => w.body.verified ?? w.body.duplicate),
    };
    check(
      ctx,
      "a webhook copy either verified (200 verified:true) or was a duplicate (200 duplicate:true)",
      hooks.every((w) => w.body.verified === true || w.body.duplicate === true),
      histogramOf(hooks.map((w) => JSON.stringify(w.body))),
    );
    if (!flip) {
      check(
        ctx,
        "stable truth: row and every sync response equal the truth",
        rows.length === 1 && Boolean(rows[0].premium) === before.premium &&
          syncs.every((s) => billingOf(s)?.premium === before.premium),
        `row.premium=${rows[0]?.premium} truth=${before.premium}`,
      );
      checkNoLostUpdate(ctx, user, true);
    } else {
      // two actors (client sync + RevenueCat webhook) racing on one row while
      // the truth flips: the freshest verification must win. Timing-dependent
      // → soft here; stale_write_lands_last is the deterministic hard pin.
      checkNoLostUpdate(ctx, user, true);
    }
  },

  async stale_write_lands_last(ctx, user, token) {
    const before = randomTruth(ctx.prng);
    const after: Truth = before.premium
      ? { premium: false, expiresAt: null, product: before.product }
      : {
        premium: true,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        product: "pickle_sensei_pro_monthly",
      };
    const holdMs = STRESS_LATENCY_MS * 4 + ctx.prng.int(0, STRESS_LATENCY_MS);
    ctx.shape = { k: 2, before, after, holdMs };
    // Lane A's verification is answered first (`before`), lane B's second
    // (`after`, the fresher truth). A's upsert then hits a slow database hop
    // and reaches the row AFTER B's — the stale verdict arrives last.
    installRevenueCat(ctx, (n) => (n === 0 ? before : after));
    // The second verification answers strictly later (≥ 2 ms) so the two
    // verified_at stamps are distinct and ordered; the stale write's hold
    // (≥ 4 hops) outlasts that plus the fresh write's own database hop.
    let rcCalls = 0;
    ctx.h.fake.overrides.rcDelayMs =
      () => (rcCalls++ === 0 ? 0 : STRESS_LATENCY_MS * 2);
    writeDelayMs = (w) => (w.premium === before.premium ? holdMs : 0);
    const syncs = await Promise.all([
      call(
        ctx,
        0,
        "sync",
        syncRequest(token, ipFor(ctx.scenario, ctx.iteration, 1)),
      ),
      (async () => {
        // B starts once A's verification is in flight (call-during-call).
        await sleep(1);
        return call(
          ctx,
          1,
          "sync",
          syncRequest(token, ipFor(ctx.scenario, ctx.iteration, 1)),
        );
      })(),
    ]);
    const rows = billingRows(ctx, user);
    check(
      ctx,
      "every call is 200",
      syncs.every((s) => s.status === 200),
      histogramOf(syncs.map((s) => String(s.status))),
    );
    check(
      ctx,
      "exactly one billing row",
      rows.length === 1,
      `rows=${rows.length}`,
    );
    const writes = writesFor(user);
    const byArrival = writes.slice().sort((a, b) => a.arrivedAt - b.arrivedAt);
    const staleWrite = writes.find((w) => w.premium === before.premium);
    const freshWrite = writes.find((w) => w.premium === after.premium);
    const staleLandedLast = writes.length === 2 &&
      byArrival.at(-1)!.premium === before.premium;
    const stampsOrdered = staleWrite !== undefined &&
      freshWrite !== undefined &&
      staleWrite.verifiedAt < freshWrite.verifiedAt;
    ctx.observations = {
      rowPremium: rows[0]?.premium,
      rcServed: ctx.rcServed.map((r) => r.premium),
      responsesPremium: syncs.map((s) => billingOf(s)?.premium),
      staleLandedLast,
      stampsOrdered,
    };
    check(
      ctx,
      "precondition: the stale verdict's upsert reached the database last, with a strictly older verified_at",
      staleLandedLast && stampsOrdered,
      JSON.stringify(writes),
    );
    checkNoLostUpdate(ctx, user);
    const freshCaller = syncs.find((s) =>
      billingOf(s)?.premium === after.premium
    );
    check(
      ctx,
      "the caller whose verification saw the fresher verdict and the row agree on premium",
      rows.length === 1 && freshCaller !== undefined &&
        Boolean(rows[0].premium) === after.premium,
      `freshCaller.premium=${
        freshCaller ? billingOf(freshCaller)?.premium : "none"
      } row.premium=${rows[0]?.premium}`,
    );
  },

  async logout_during_sync(ctx, user, token) {
    const k = ctx.prng.int(2, 8);
    const logoutAfterMs = ctx.prng.int(0, STRESS_LATENCY_MS * 3);
    const truth = randomTruth(ctx.prng);
    ctx.shape = { k, logoutAfterMs, truth };
    installRevenueCat(ctx, () => truth);
    let logoutDoneAt = Number.POSITIVE_INFINITY;
    const lanes: Array<Promise<Lane>> = Array.from(
      { length: k },
      (_, i) =>
        call(
          ctx,
          i,
          "sync",
          syncRequest(token, ipFor(ctx.scenario, ctx.iteration, 1)),
        ),
    );
    lanes.push(
      (async () => {
        await sleep(logoutAfterMs);
        const l = await call(
          ctx,
          k,
          "logout",
          edgeRequest("POST", "/v1/auth/logout", {
            token,
            ip: ipFor(ctx.scenario, ctx.iteration, 2),
          }),
        );
        logoutDoneAt = l.endedAt;
        return l;
      })(),
    );
    const all = await Promise.all(lanes);
    const syncs = all.filter((l) => l.op === "sync");
    const logout = all.find((l) => l.op === "logout")!;
    const rcBefore = ctx.rcServed.length;
    const post = await call(
      ctx,
      k + 1,
      "sync.after_logout",
      syncRequest(token, ipFor(ctx.scenario, ctx.iteration, 3)),
    );
    const rows = billingRows(ctx, user);
    const startedAfter = syncs.filter((s) => s.startedAt > logoutDoneAt);
    ctx.observations = {
      syncStatuses: syncs.map((s) => s.status),
      startedAfterLogout: startedAfter.length,
      startedAfterLogoutAccepted:
        startedAfter.filter((s) => s.status === 200).length,
    };
    check(
      ctx,
      "logout is 204/200",
      logout.status === 204 || logout.status === 200,
      `→ ${logout.status}`,
    );
    check(
      ctx,
      "every in-flight sync is 200 or 401 (no 5xx)",
      syncs.every((s) => s.status === 200 || s.status === 401),
      histogramOf(syncs.map((s) => String(s.status))),
    );
    check(
      ctx,
      "at most one billing row",
      rows.length <= 1,
      `rows=${rows.length}`,
    );
    check(
      ctx,
      "a row exists iff some sync succeeded, and it equals the truth",
      (rows.length === 1) === syncs.some((s) => s.status === 200) &&
        (rows.length === 0 || Boolean(rows[0].premium) === truth.premium),
      `rows=${rows.length} ok=${syncs.filter((s) => s.status === 200).length}`,
    );
    check(
      ctx,
      "the revoked bearer is refused afterwards (401) without a RevenueCat call",
      post.status === 401 && ctx.rcServed.length === rcBefore,
      `→ ${post.status} rc delta=${ctx.rcServed.length - rcBefore}`,
    );
    check(
      ctx,
      "a sync that STARTED after logout completed is never 200",
      startedAfter.every((s) => s.status !== 200),
      `${startedAfter.length} started after; ${
        startedAfter.filter((s) => s.status === 200).length
      } accepted`,
    );
  },

  async rotation_during_sync(ctx, user, token, refreshToken) {
    const k = ctx.prng.int(2, 6);
    const m = ctx.prng.int(1, 3);
    const refreshAfterMs = ctx.prng.int(0, STRESS_LATENCY_MS * 2);
    const truth = randomTruth(ctx.prng);
    ctx.shape = { k, m, refreshAfterMs, truth };
    installRevenueCat(ctx, () => truth);
    const lanes: Array<Promise<Lane[]>> = Array.from(
      { length: k },
      (_, i) =>
        call(
          ctx,
          i,
          "sync.old",
          syncRequest(token, ipFor(ctx.scenario, ctx.iteration, 1)),
        ).then((l) => [l]),
    );
    lanes.push(
      (async () => {
        await sleep(refreshAfterMs);
        const refresh = await call(
          ctx,
          k,
          "refresh",
          edgeRequest("POST", "/v1/auth/refresh", {
            ip: ipFor(ctx.scenario, ctx.iteration, 2),
            body: { refreshToken },
          }),
        );
        const session = (refresh.body.session ?? {}) as Record<string, unknown>;
        const fresh = typeof session.accessToken === "string"
          ? session.accessToken
          : "";
        const after = await Promise.all(
          Array.from(
            { length: m },
            (_, j) =>
              call(
                ctx,
                k + 1 + j,
                "sync.new",
                syncRequest(fresh, ipFor(ctx.scenario, ctx.iteration, 3)),
              ),
          ),
        );
        return [refresh, ...after];
      })(),
    );
    const all = (await Promise.all(lanes)).flat();
    const refresh = all.find((l) => l.op === "refresh")!;
    const syncs = all.filter((l) => l.op.startsWith("sync"));
    check(
      ctx,
      "refresh rotated the session (200)",
      refresh.status === 200,
      `→ ${refresh.status}`,
    );
    check(
      ctx,
      "every sync — on the old or the rotated bearer — is 200",
      syncs.every((s) => s.status === 200),
      histogramOf(syncs.map((s) => `${s.op}:${s.status}`)),
    );
    checkStableBurst(ctx, user, truth, syncs);
  },

  async clock_skew(ctx, user, token) {
    const k = ctx.prng.int(2, 8);
    const mode = ctx.prng.int(0, 3);
    const deltaMs = ctx.prng.int(-60, 60);
    const malformed = [
      "",
      "not-a-date",
      "2026-13-45T99:99:99Z",
      "1e12",
      " ",
    ][ctx.prng.int(0, 4)];
    ctx.shape = {
      k,
      mode: [
        "near_now",
        "malformed_string",
        "numeric_expires",
        "skewed_request_date",
      ][mode],
      deltaMs,
      malformed,
    };
    let expiresIso = "";
    ctx.h.fake.overrides.rcDelayMs = () =>
      ctx.prng.int(0, STRESS_LATENCY_MS * 2);
    ctx.h.fake.overrides.subscriber = () => {
      if (mode === 1) {
        return {
          entitlements: {
            pickle_sensei_pro: {
              expires_date: malformed,
              product_identifier: "pickle_sensei_pro_monthly",
            },
          },
        };
      }
      if (mode === 2) {
        return {
          entitlements: {
            pickle_sensei_pro: {
              expires_date: Date.now() + 86_400_000,
              product_identifier: "pickle_sensei_pro_monthly",
            },
          },
        };
      }
      // near_now / skewed_request_date: the entitlement expires deltaMs from
      // the server's own clock at the moment RevenueCat answers.
      expiresIso = new Date(Date.now() + deltaMs).toISOString();
      const sub: Record<string, unknown> = {
        entitlements: {
          pickle_sensei_pro: {
            expires_date: expiresIso,
            product_identifier: "pickle_sensei_pro_monthly",
          },
        },
      };
      if (mode === 3) {
        sub.request_date_ms = Date.now() - 3_600_000 * ctx.prng.int(1, 48);
      }
      return sub;
    };
    const syncs = await Promise.all(
      Array.from(
        { length: k },
        (_, i) =>
          call(
            ctx,
            i,
            "sync",
            syncRequest(token, ipFor(ctx.scenario, ctx.iteration, 1)),
          ),
      ),
    );
    const rows = billingRows(ctx, user);
    const ok = syncs.filter((s) => s.status === 200);
    check(
      ctx,
      "every call is 200 (malformed / boundary expiry is never a 5xx)",
      syncs.every((s) => s.status === 200),
      histogramOf(syncs.map((s) => `${s.status}${s.code ? `:${s.code}` : ""}`)),
    );
    check(
      ctx,
      "exactly one billing row",
      rows.length === 1,
      `rows=${rows.length}`,
    );
    if (mode === 1 || mode === 2) {
      check(
        ctx,
        "unparseable / non-string expires_date never grants premium",
        ok.every((s) => billingOf(s)?.premium === false) && rows.length === 1 &&
          rows[0].premium === false,
        histogramOf(ok.map((s) => String(billingOf(s)?.premium))),
      );
    } else {
      // premium:true ⇒ expiry is after the request began (the check happened
      // inside the request); premium:false ⇒ expiry was ≤ the request's end.
      const consistent = ok.every((s) => {
        const b = billingOf(s)!;
        const t0 = performance.timeOrigin + s.startedAt;
        const t1 = performance.timeOrigin + s.endedAt;
        if (b.premium) {
          return b.expiresAt !== null && Date.parse(b.expiresAt) > t0 - 1;
        }
        return Date.parse(expiresIso) <= t1 + 1;
      });
      check(
        ctx,
        "each response's premium agrees with its own expiry-vs-clock window",
        consistent,
        histogramOf(ok.map((s) => String(billingOf(s)?.premium))),
      );
      check(
        ctx,
        "row is not torn: premium ⇒ expires_at set to the served expiry; !premium ⇒ expires_at null",
        rows.length === 1 &&
          (rows[0].premium
            ? typeof rows[0].expires_at === "string"
            : rows[0].expires_at === null),
        JSON.stringify(rows[0] ?? null),
      );
      const alreadyExpiredWhenTold = ok.filter((s) => {
        const b = billingOf(s)!;
        return b.premium && b.expiresAt !== null &&
          Date.parse(b.expiresAt) <= Date.parse(b.verifiedAt);
      }).length;
      ctx.observations = {
        alreadyExpiredWhenTold,
        deltaMs,
        premiumResponses: ok.filter((s) => billingOf(s)?.premium).length,
      };
      check(
        ctx,
        "premium:true is never reported with an expiresAt ≤ verifiedAt",
        alreadyExpiredWhenTold === 0,
        `${alreadyExpiredWhenTold}/${ok.length} responses (δ=${deltaMs}ms)`,
        true,
      );
    }
  },

  async rc_failure_abort(ctx, user, token) {
    const k = ctx.prng.int(2, 8);
    const truth = randomTruth(ctx.prng);
    const failMask = Array.from({ length: k }, () => ctx.prng.next() < 0.4);
    const abortMask = Array.from({ length: k }, () => ctx.prng.next() < 0.4);
    ctx.shape = { k, truth, failMask, abortMask };
    let n = 0;
    ctx.h.fake.overrides.rcDelayMs = () =>
      ctx.prng.int(0, STRESS_LATENCY_MS * 2);
    ctx.h.fake.overrides.subscriber = () => {
      const fail = failMask[Math.min(n, k - 1)];
      n++;
      if (fail) return null; // RevenueCat 500
      ctx.rcServed.push({
        premium: truth.premium,
        expiresAt: truth.expiresAt,
        user,
      });
      return subscriberFor(truth);
    };
    const syncs = await Promise.all(
      Array.from({ length: k }, (_, i) => {
        const ac = new AbortController();
        if (abortMask[i]) {
          sleep(ctx.prng.int(0, STRESS_LATENCY_MS)).then(() =>
            ac.abort(new DOMException("client gone", "AbortError"))
          );
        }
        return call(
          ctx,
          i,
          abortMask[i] ? "sync.aborted" : "sync",
          syncRequest(token, ipFor(ctx.scenario, ctx.iteration, 1), ac.signal),
        );
      }),
    );
    const rows = billingRows(ctx, user);
    const ok = syncs.filter((s) => s.status === 200);
    const unavailable = syncs.filter((s) =>
      s.status === 502 && s.code === "billing_unavailable"
    );
    check(
      ctx,
      "every call is 200 or 502 billing_unavailable — nothing else, no hang",
      ok.length + unavailable.length === k,
      histogramOf(
        syncs.map((s) => `${s.op}:${s.status}${s.code ? `:${s.code}` : ""}`),
      ),
    );
    check(
      ctx,
      "successes == RevenueCat answers served; failures wrote nothing",
      ok.length === ctx.rcServed.length &&
        (rows.length === (ok.length > 0 ? 1 : 0)),
      `ok=${ok.length} served=${ctx.rcServed.length} rows=${rows.length}`,
    );
    if (ok.length > 0) {
      check(
        ctx,
        "row equals the truth",
        Boolean(rows[0]?.premium) === truth.premium,
        `row=${rows[0]?.premium} truth=${truth.premium}`,
      );
    }
    check(
      ctx,
      "aborted clients still get a complete, well-formed response (server work is not torn)",
      syncs.filter((s) => s.op === "sync.aborted").every((s) =>
        s.status === 200 || s.status === 502
      ),
      histogramOf(
        syncs.filter((s) => s.op === "sync.aborted").map((s) =>
          String(s.status)
        ),
      ),
    );
  },

  async cross_user(ctx, user, token) {
    const other = ctx.prng.uuid();
    const bootB = await bootstrap(
      ctx.h,
      other,
      ipFor(ctx.scenario, ctx.iteration, 4),
    );
    const kA = ctx.prng.int(1, 5);
    const kB = ctx.prng.int(1, 5);
    const truthA = randomTruth(ctx.prng);
    const truthB: Truth = truthA.premium
      ? {
        premium: false,
        expiresAt: null,
        product: "pickle_sensei_pro_monthly",
      }
      : {
        premium: true,
        expiresAt: null,
        product: "pickle_sensei_pro_lifetime",
      };
    ctx.shape = { kA, kB, truthA, truthB, other };
    installRevenueCat(
      ctx,
      (_n, u) => (u === user ? truthA : u === other ? truthB : null),
    );
    const lanes = ctx.prng.shuffle([
      ...Array.from(
        { length: kA },
        (_, i) => () =>
          call(
            ctx,
            i,
            "sync.A",
            syncRequest(token, ipFor(ctx.scenario, ctx.iteration, 1)),
          ),
      ),
      ...Array.from(
        { length: kB },
        (_, i) => () =>
          call(
            ctx,
            kA + i,
            "sync.B",
            syncRequest(
              bootB.accessToken,
              ipFor(ctx.scenario, ctx.iteration, 2),
            ),
          ),
      ),
    ]);
    const all = await Promise.all(lanes.map((fn) => fn()));
    const a = all.filter((l) => l.op === "sync.A");
    const b = all.filter((l) => l.op === "sync.B");
    const rowsA = billingRows(ctx, user);
    const rowsB = billingRows(ctx, other);
    check(ctx, "bootstrap B is 200", bootB.status === 200, `→ ${bootB.status}`);
    check(
      ctx,
      "every call is 200",
      all.every((l) => l.status === 200),
      histogramOf(all.map((l) => `${l.op}:${l.status}`)),
    );
    check(
      ctx,
      "one row per user",
      rowsA.length === 1 && rowsB.length === 1,
      `A=${rowsA.length} B=${rowsB.length}`,
    );
    check(
      ctx,
      "rows and responses never cross users",
      Boolean(rowsA[0]?.premium) === truthA.premium &&
        Boolean(rowsB[0]?.premium) === truthB.premium &&
        a.every((l) =>
          billingOf(l)?.premium === truthA.premium &&
          accessOf(l)?.premium === truthA.premium
        ) &&
        b.every((l) =>
          billingOf(l)?.premium === truthB.premium &&
          accessOf(l)?.premium === truthB.premium
        ),
      `A row=${rowsA[0]?.premium}/${truthA.premium} B row=${
        rowsB[0]?.premium
      }/${truthB.premium}`,
    );
    check(
      ctx,
      "RevenueCat was asked about exactly the calling user each time",
      ctx.rcServed.length === kA + kB &&
        ctx.rcServed.filter((r) => r.user === user).length === kA,
      `served=${ctx.rcServed.length} forA=${
        ctx.rcServed.filter((r) => r.user === user).length
      }`,
    );
  },

  async free_rating_spend(ctx, user, token) {
    const kSync = ctx.prng.int(1, 5);
    const kPermit = ctx.prng.int(2, 8);
    // spent_free:     no row, RevenueCat says no membership   → zero permits
    // member:         row premium, RevenueCat still premium   → every permit
    // lapsed_member:  row premium, RevenueCat now lapsed      → syncs revoke;
    //                 permits that beat the revocation may pass, the row and
    //                 a sequential permit afterwards must not.
    const variant =
      (["spent_free", "spent_free", "member", "lapsed_member"] as const)[
        ctx.prng.int(0, 3)
      ];
    const truth: Truth = variant === "member"
      ? {
        premium: true,
        expiresAt: null,
        product: "pickle_sensei_pro_lifetime",
      }
      : {
        premium: false,
        expiresAt: null,
        product: "pickle_sensei_pro_monthly",
      };
    ctx.shape = { kSync, kPermit, variant, truth };
    if (variant !== "spent_free") {
      ctx.h.fake.tables.billing_entitlements.push({
        user_id: user,
        premium: true,
        product_key: "pickle_sensei_pro_lifetime",
        expires_at: null,
        verified_at: new Date(Date.now() - 600_000).toISOString(),
      });
    }
    // both lifetime free ratings already spent (scored shots + identity ledger)
    const spent = 2;
    for (let i = 0; i < spent; i++) {
      ctx.h.fake.tables.shots.push({
        id: ctx.prng.uuid(),
        user_id: user,
        session_id: null,
        result_kind: "scored",
        analysis_permit_id: ctx.prng.uuid(),
        created_at: new Date(Date.now() - 3_600_000).toISOString(),
      });
    }
    ctx.h.fake.identityLedger.set(`google:${user}`, spent);
    installRevenueCat(ctx, () => truth);
    const lanes = ctx.prng.shuffle([
      ...Array.from(
        { length: kSync },
        (_, i) => () =>
          call(
            ctx,
            i,
            "sync",
            syncRequest(token, ipFor(ctx.scenario, ctx.iteration, 1)),
          ),
      ),
      ...Array.from({ length: kPermit }, (_, i) => () =>
        call(
          ctx,
          kSync + i,
          "permit",
          edgeRequest("POST", "/v1/analysis-permits", {
            token,
            ip: ipFor(ctx.scenario, ctx.iteration, 2),
            body: { idempotencyKey: `stress-${ctx.seed}-${i}` },
          }),
        )),
    ]);
    const all = await Promise.all(lanes.map((fn) => fn()));
    const syncs = all.filter((l) => l.op === "sync");
    const permits = all.filter((l) => l.op === "permit");
    const accepted = permits.filter((p) =>
      p.status === 200 || p.status === 201
    );
    const paywalled = permits.filter((p) =>
      p.status === 402 && p.code === "access.paywall_required"
    );
    const reservedRows = ctx.h.fake.tables.analysis_permits.filter((p) =>
      p.user_id === user && p.status === "reserved"
    );
    const scored =
      ctx.h.fake.tables.shots.filter((s) =>
        s.user_id === user && s.result_kind === "scored"
      ).length;
    const rows = billingRows(ctx, user);
    ctx.observations = {
      accepted: accepted.length,
      paywalled: paywalled.length,
      reservedRows: reservedRows.length,
      scored,
    };
    check(
      ctx,
      "every sync is 200",
      syncs.every((s) => s.status === 200),
      histogramOf(syncs.map((s) => String(s.status))),
    );
    check(
      ctx,
      "no 5xx anywhere",
      all.every((l) => l.status < 500),
      histogramOf(all.map((l) => `${l.op}:${l.status}`)),
    );
    check(
      ctx,
      "every permit call is accepted (200/201) or 402 paywall_required",
      permits.length === accepted.length + paywalled.length,
      histogramOf(
        permits.map((p) => `${p.status}${p.code ? `:${p.code}` : ""}`),
      ),
    );
    check(
      ctx,
      "one billing row equal to the truth",
      rows.length === 1 && Boolean(rows[0].premium) === truth.premium,
      `rows=${rows.length} premium=${rows[0]?.premium}`,
    );
    check(
      ctx,
      "scored count untouched by billing syncs",
      scored === spent,
      `scored=${scored}`,
    );
    check(
      ctx,
      "accepted permits == reserved rows (no phantom / duplicate reservations)",
      accepted.length === reservedRows.length,
      `accepted=${accepted.length} reserved rows=${reservedRows.length}`,
    );
    if (variant === "lapsed_member") {
      const rcBefore = ctx.rcServed.length;
      const post = await call(
        ctx,
        kSync + kPermit,
        "permit.after_revoke",
        edgeRequest("POST", "/v1/analysis-permits", {
          token,
          ip: ipFor(ctx.scenario, ctx.iteration, 3),
          body: { idempotencyKey: `stress-${ctx.seed}-post` },
        }),
      );
      check(
        ctx,
        "after the revoking syncs settle, a fresh reservation is paywalled (402) and never re-verifies",
        post.status === 402 && post.code === "access.paywall_required" &&
          ctx.rcServed.length === rcBefore,
        `→ ${post.status}${post.code ? `:${post.code}` : ""} rc delta=${
          ctx.rcServed.length - rcBefore
        }`,
      );
      check(
        ctx,
        "every sync response reports the lapse (premium:false, canStartRating:false, used:2)",
        syncs.every((s) => {
          const a = accessOf(s);
          const fr = (a?.freeRatings ?? {}) as Record<string, unknown>;
          return a?.premium === false && a?.canStartRating === false &&
            fr.used === 2;
        }),
        JSON.stringify(syncs.map((s) => accessOf(s)?.canStartRating)),
      );
      // Permits reserved while the stale premium row was still standing are the
      // documented window between RevenueCat's lapse and the next sync.
      ctx.observations.acceptedBeforeRevocationLanded = accepted.length;
    } else if (!truth.premium) {
      check(
        ctx,
        "NO DOUBLE SPEND: with both free ratings spent and no membership, zero permits are reserved",
        accepted.length === 0 && paywalled.length === kPermit &&
          reservedRows.length === 0,
        `accepted=${accepted.length} paywalled=${paywalled.length} reserved rows=${reservedRows.length}`,
      );
      check(
        ctx,
        "every sync response says paywallRequired / canStartRating:false / used:2",
        syncs.every((s) => {
          const a = accessOf(s);
          const fr = (a?.freeRatings ?? {}) as Record<string, unknown>;
          return a?.paywallRequired === true && a?.canStartRating === false &&
            fr.used === 2 && fr.availableToReserve === 0;
        }),
        JSON.stringify(syncs.map((s) => accessOf(s)?.canStartRating)),
      );
    } else {
      check(
        ctx,
        "membership bypasses the allowance: every reservation is accepted, none paywalled",
        accepted.length === kPermit && paywalled.length === 0 &&
          reservedRows.length === kPermit,
        `accepted=${accepted.length} paywalled=${paywalled.length} reserved rows=${reservedRows.length}`,
      );
      check(
        ctx,
        "every sync response says canStartRating:true with used:2",
        syncs.every((s) => {
          const a = accessOf(s);
          const fr = (a?.freeRatings ?? {}) as Record<string, unknown>;
          return a?.canStartRating === true && a?.paywallRequired === false &&
            fr.used === 2;
        }),
        JSON.stringify(syncs.map((s) => accessOf(s)?.canStartRating)),
      );
    }
  },
};

// ── runner ───────────────────────────────────────────────────────────────────

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-billing-sync/latest/",
    import.meta.url,
  ).pathname;
}

function replayCommand(scenario: ScenarioName, seed: number): string {
  return `cd supabase/functions/api/__wf__ && STRESS_ONLY=${scenario} STRESS_REPLAY=${seed} STRESS_SEED=${STRESS_SEED} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json stress_billing_sync_concurrency.test.ts`;
}

async function runIteration(
  h: XcHarness,
  scenario: ScenarioName,
  iteration: number,
  seed: number,
): Promise<IterationOutcome> {
  h.fake.reset(seed, STRESS_LATENCY_MS);
  h.upstreamCalls.length = 0;
  billingWrites.length = 0;
  writeDelayMs = undefined;
  const prng = new Prng(seed);
  const ctx: Ctx = {
    h,
    prng,
    scenario,
    iteration,
    seed,
    lanes: [],
    checks: [],
    shape: {},
    observations: {},
    rcServed: [],
  };
  const user = prng.uuid();
  const t0 = performance.now();
  const { timedOut } = await bounded(async () => {
    const boot = await bootstrap(h, user, ipFor(scenario, iteration, 0));
    check(ctx, "bootstrap is 200", boot.status === 200, `→ ${boot.status}`);
    if (boot.status !== 200) return;
    await bodies[scenario](ctx, user, boot.accessToken, boot.refreshToken);
  });
  const durationMs = Math.round(performance.now() - t0);
  if (timedOut) {
    check(
      ctx,
      `bounded wall time (≤ ${STRESS_DEADLINE_MS}ms) — no deadlock / hang`,
      false,
      `iteration did not finish within ${STRESS_DEADLINE_MS}ms (${ctx.lanes.length} lanes completed)`,
    );
  }
  h.fake.overrides = {};
  const broken = ctx.checks.filter((c) => !c.holds && !c.soft).map((c) =>
    `${c.name} — ${c.detail}`
  );
  return {
    scenario,
    iteration,
    seed,
    user,
    shape: ctx.shape,
    statuses: histogram(
      ctx.lanes.map((l) => `${l.op}:${l.status}${l.code ? `:${l.code}` : ""}`),
    ),
    checks: ctx.checks,
    broken,
    observations: ctx.observations,
    rcCalls: h.fake.counters["rc.get_subscriber"] ?? 0,
    durationMs,
    deadlockSuspected: timedOut,
    replay: replayCommand(scenario, seed),
  };
}

interface CampaignSummary {
  scenario: ScenarioName;
  iterations: number;
  lanes: number;
  broken: number;
  deadlocks: number;
  softViolations: Record<string, number>;
  brokenChecks: Record<string, number>;
  failingSeeds: number[];
  maxIterationMs: number;
  totalMs: number;
}

async function campaign(
  scenario: ScenarioName,
): Promise<{ summary: CampaignSummary; outcomes: IterationOutcome[] }> {
  const h = await loadXcHarness();
  installWriteTap();
  const seeds = STRESS_REPLAY
    ? [Number(STRESS_REPLAY)]
    : Array.from({ length: STRESS_ITER }, (_, i) => iterationSeed(scenario, i));
  const outcomes: IterationOutcome[] = [];
  const t0 = performance.now();
  for (const [i, seed] of seeds.entries()) {
    outcomes.push(await runIteration(h, scenario, i, seed));
  }
  const totalMs = Math.round(performance.now() - t0);
  const softViolations: Record<string, number> = {};
  const brokenChecks: Record<string, number> = {};
  for (const o of outcomes) {
    for (const c of o.checks) {
      if (c.holds) continue;
      const bucket = c.soft ? softViolations : brokenChecks;
      bucket[c.name] = (bucket[c.name] ?? 0) + 1;
    }
  }
  const summary: CampaignSummary = {
    scenario,
    iterations: outcomes.length,
    lanes: outcomes.reduce(
      (n, o) => n + Object.values(o.statuses).reduce((a, b) => a + b, 0),
      0,
    ),
    broken: outcomes.filter((o) => o.broken.length > 0).length,
    deadlocks: outcomes.filter((o) => o.deadlockSuspected).length,
    softViolations,
    brokenChecks,
    failingSeeds: outcomes.filter((o) => o.broken.length > 0).map((o) =>
      o.seed
    ),
    maxIterationMs: Math.max(0, ...outcomes.map((o) => o.durationMs)),
    totalMs,
  };
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    `${dir}${scenario}.json`,
    JSON.stringify(
      {
        unit: "route-post-v1-billing-sync",
        lens: "concurrency",
        campaignSeed: STRESS_SEED,
        latencyMs: STRESS_LATENCY_MS,
        deadlineMs: STRESS_DEADLINE_MS,
        summary,
        // seed → outcome table
        table: outcomes.map((o) => ({
          seed: o.seed,
          iteration: o.iteration,
          outcome: o.deadlockSuspected
            ? "DEADLOCK"
            : o.broken.length
            ? "BROKEN"
            : "HELD",
          shape: o.shape,
          statuses: o.statuses,
          broken: o.broken,
          soft: o.checks.filter((c) => c.soft && !c.holds).map((c) =>
            `${c.name} — ${c.detail}`
          ),
          observations: o.observations,
          rcCalls: o.rcCalls,
          durationMs: o.durationMs,
          replay: o.replay,
        })),
      },
      null,
      2,
    ),
  );
  console.log(
    `[stress billing_sync/${scenario}] iterations=${summary.iterations} lanes=${summary.lanes} broken=${summary.broken} deadlocks=${summary.deadlocks} max=${summary.maxIterationMs}ms total=${summary.totalMs}ms → ${dir}${scenario}.json`,
  );
  for (const [name, n] of Object.entries(brokenChecks)) {
    console.log(`[stress]   BROKEN ×${n}: ${name}`);
  }
  for (const [name, n] of Object.entries(softViolations)) {
    console.log(`[stress]   soft   ×${n}: ${name}`);
  }
  return { summary, outcomes };
}

for (const scenario of SCENARIOS) {
  Deno.test({
    name: `stress billing_sync/${scenario}: ${
      STRESS_REPLAY
        ? `replay seed ${STRESS_REPLAY}`
        : `${STRESS_ITER} seeded interleavings`
    }`,
    ignore: STRESS_ONLY !== "" && STRESS_ONLY !== scenario,
    // The harness swaps globalThis.fetch and Deno.serve for the lifetime of
    // the process (shared with the xc matrix); timers belong to the modelled
    // upstreams, so leak checks are off exactly as in that suite.
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const { summary, outcomes } = await campaign(scenario);
      assert(
        summary.deadlocks === 0,
        `${summary.deadlocks} iteration(s) breached the ${STRESS_DEADLINE_MS}ms deadline (seeds ${
          outcomes.filter((o) => o.deadlockSuspected).map((o) => o.seed).join(
            ",",
          )
        })`,
      );
      assert(
        summary.broken === 0,
        `${summary.broken}/${summary.iterations} iterations BROKEN:\n` +
          outcomes.filter((o) => o.broken.length).map((o) =>
            `  seed ${o.seed}: ${o.broken.join(" | ")}\n    replay: ${o.replay}`
          ).join("\n"),
      );
    },
  });
}
