// stress — POST /v1/analysis-permits under a SEEDED concurrency scheduler.
//
// Drives the REAL edge handler (../index.ts, loaded in-process by
// xc_concurrency_harness.ts over its stateful Supabase/RevenueCat fake) with
// Promise.all bursts whose shape, timing and actors are all drawn from one
// PRNG per iteration, so any iteration replays from its seed alone.
//
// Each iteration composes, from its seed: duplicate calls (same idempotency
// key), distinct keys past the two-free-rating allowance, call-during-call
// (finalize / shots:sync racing new reservations), client cancel-during-call
// (the request is abandoned by the caller while the handler keeps running,
// then retried with the same key), two actors on the same row/id (a second
// user replaying the first user's keys and permit ids), rotation/logout
// during the burst, and clock skew (a bearer whose exp straddles the burst,
// plus an edge-clock jump mid-burst). Every iteration asserts: idempotency
// (one permit id per key), no double spend (live reserved + lifetime scored
// ≤ 2 for a free user), no duplicate rows, no lost update (every 200 ↔ one
// row; a settled permit has exactly one terminal outcome), no 5xx / no
// unexpected 429, and bounded wall time (a deadlock surfaces as TIMEOUT).
//
// Scale: STRESS_ITER iterations (default 24 so the suite stays fast; the
// campaign runs ≥500), STRESS_SEED base seed, STRESS_LATENCY_MS max seeded
// upstream latency, STRESS_ITER_TIMEOUT_MS wall-time bound per iteration.
// Replay one iteration: STRESS_REPLAY_SEED=<seed from the JSON table>.
// Output: <STRESS_OUT_DIR>/stress_analysis_permits_edge.json — a table of
// { seed → outcome } plus the violated invariants of every BROKEN iteration.

import { assert, assertEquals } from "@std/assert";
import {
  b64url,
  bootstrap,
  edgeRequest,
  envInt,
  histogram,
  jwtPayload,
  loadXcHarness,
  Prng,
  readJson,
  sleep,
  syncShotPayload,
  type XcHarness,
} from "./xc_concurrency_harness.ts";

const STRESS_ITER = envInt("STRESS_ITER", 24);
const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 8);
const STRESS_ITER_TIMEOUT_MS = envInt("STRESS_ITER_TIMEOUT_MS", 15_000);
const REPLAY_SEED = envInt("STRESS_REPLAY_SEED", 0);

/** The route's own per-user budget (index.ts ROUTE_LIMITS scope "permits"):
 * every iteration uses a fresh user and stays under it, so a 429 is never a
 * masked invariant — it is an unexpected verdict. */
const PERMITS_BUDGET = 30;

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-analysis-permits/latest/", import.meta.url).pathname;
}

/** splitmix-style 32-bit mix: iteration i of base seed s → its own seed. */
function iterationSeed(base: number, i: number): number {
  let x = (base + Math.imul(i + 1, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0 || 1;
}

// ── Edge clock (models an NTP step on the edge isolate mid-burst). Installed
// for the duration of the campaign only; with skew 0 it is transparent. ──────
const realDateNow = Date.now;
let clockSkewMs = 0;
function installClock(): () => void {
  Date.now = () => realDateNow() + clockSkewMs;
  return () => {
    clockSkewMs = 0;
    Date.now = realDateNow;
  };
}

type Actor = "U" | "V";

interface Op {
  lane: number;
  actor: Actor;
  kind: "reserve" | "finalize" | "sync" | "access" | "refresh" | "logout" | "skew";
  delayMs: number;
  key?: string;
  /** index into the iteration's phase-1 permit list */
  permitRef?: number;
  /** finalize outcome / sync resultKind */
  outcome?: string;
  /** client abandons the request (server keeps running); retried afterwards */
  cancel?: boolean;
  /** edge clock jump (ms) */
  skewMs?: number;
  /** use the actor's latest bearer (post-refresh) or the original one */
  bearer: "original" | "latest";
  /** V acts on U's permit id (two actors on the same row) */
  foreignPermit?: boolean;
}

interface OpResult {
  lane: number;
  actor: Actor;
  kind: Op["kind"];
  key?: string;
  permitRef?: number;
  cancel?: boolean;
  status: number;
  code?: string;
  permitId?: string;
  startedAt: number;
  endedAt: number;
  /** edge clock (Date.now, skew included) when the request was issued / answered */
  startedEpochMs: number;
  endedEpochMs: number;
  bearerExp?: number;
}

interface IterationRow {
  seed: number;
  iteration: number;
  outcome: "HELD" | "BROKEN" | "TIMEOUT";
  features: string[];
  premium: boolean;
  requests: number;
  statusHistogram: Record<string, number>;
  durationMs: number;
  violated: string[];
  replay: string;
  detail?: Record<string, unknown>;
}

interface ActorState {
  sub: string;
  ip: string;
  original: string;
  latest: string;
  refreshToken: string;
  /** performance.now() when a logout was issued / had completed */
  logoutStartedAt: number | null;
  loggedOutAt: number | null;
}

const FINALIZE_OUTCOMES = ["low_confidence", "cancelled", "failed", "unsupported"];

function accessInvariantViolations(
  access: Record<string, unknown> | undefined,
  premiumExpected: boolean,
  where: string,
): string[] {
  const out: string[] = [];
  if (!access) return [`${where}: access payload missing`];
  const fr = (access.freeRatings ?? {}) as Record<string, number>;
  const ent = Array.isArray(access.entitlements) ? (access.entitlements as string[]) : [];
  if (fr.limit !== 2) out.push(`${where}: freeRatings.limit=${fr.limit}`);
  if (fr.used + fr.remaining !== 2) out.push(`${where}: used+remaining=${fr.used}+${fr.remaining}`);
  if (fr.reserved < 0 || fr.reserved > fr.remaining) {
    out.push(`${where}: reserved=${fr.reserved} remaining=${fr.remaining}`);
  }
  if (fr.availableToReserve !== fr.remaining - fr.reserved) {
    out.push(`${where}: availableToReserve=${fr.availableToReserve}`);
  }
  const canStart = Boolean(access.premium) || fr.availableToReserve > 0;
  if (access.canStartRating !== canStart)
    out.push(`${where}: canStartRating=${access.canStartRating}`);
  if (access.paywallRequired !== !canStart)
    out.push(`${where}: paywallRequired=${access.paywallRequired}`);
  if (Boolean(access.premium) !== ent.includes("premium")) {
    out.push(`${where}: premium=${access.premium} entitlements=${JSON.stringify(ent)}`);
  }
  if (Boolean(access.premium) !== premiumExpected) {
    out.push(`${where}: premium=${access.premium} expected ${premiumExpected}`);
  }
  return out;
}

/** A bearer for the same session whose exp is `expOffsetMs` from now — a
 * GoTrue whose clock disagrees with the edge. Registered on the fake so
 * getUser() still resolves it (PostgREST/GoTrue only check the signature
 * and their own clock; the edge checks exp against ITS clock). */
function skewedBearer(h: XcHarness, token: string, expOffsetMs: number): string {
  const payload = jwtPayload(token) ?? {};
  const skewed = { ...payload, exp: Math.floor((Date.now() + expOffsetMs) / 1000) };
  const header = token.split(".")[0];
  const crafted = `${header}.${b64url(JSON.stringify(skewed))}.sig`;
  const sid = h.fake.accessIndex.get(token);
  if (sid) h.fake.accessIndex.set(crafted, sid);
  return crafted;
}

interface Plan {
  premium: boolean;
  features: string[];
  phase1Keys: string[];
  ops: Op[];
  withV: boolean;
  spreadMs: number;
  bearerExpOffsetMs: number | null;
}

/** Everything about an iteration is a pure function of its seed. */
function plan(prng: Prng): Plan {
  const features: string[] = [];
  const premium = prng.next() < 0.18;
  if (premium) features.push("premium");
  const withV = prng.next() < 0.22;
  if (withV) features.push("two-actors");
  const settle = prng.next() < 0.45;
  const phase1Keys = settle ? Array.from({ length: prng.int(1, 2) }, () => prng.uuid()) : [];
  if (settle) features.push("call-during-call");
  const withRefresh = prng.next() < 0.22;
  if (withRefresh) features.push("rotation");
  const withLogout = prng.next() < 0.16;
  if (withLogout) features.push("logout");
  const withClockJump = prng.next() < 0.14;
  if (withClockJump) features.push("clock-jump");
  const bearerExpOffsetMs = prng.next() < 0.14 ? [-1500, 600, 2500][prng.int(0, 2)] : null;
  if (bearerExpOffsetMs !== null) features.push("skewed-bearer");
  const spreadMs = prng.int(0, 40);

  const poolSize = prng.int(1, 5);
  const pool = Array.from({ length: poolSize }, () => prng.uuid());
  if (poolSize === 1) features.push("duplicate-calls");
  else features.push("distinct-keys");
  const n = prng.int(3, 14);
  const ops: Op[] = [];
  let lane = 0;
  let reserves = 0;
  let cancels = 0;
  const push = (op: Omit<Op, "lane">) => ops.push({ lane: lane++, ...op });
  const delay = () => prng.int(0, spreadMs);
  const bearer = (): Op["bearer"] => (withRefresh && prng.next() < 0.5 ? "latest" : "original");
  for (let i = 0; i < n; i++) {
    const roll = prng.next();
    if (roll < 0.6 || (phase1Keys.length === 0 && roll < 0.85)) {
      const cancel = prng.next() < 0.2;
      if (cancel) cancels++;
      reserves++;
      push({
        actor: "U",
        kind: "reserve",
        key: pool[prng.int(0, poolSize - 1)],
        delayMs: delay(),
        cancel,
        bearer: bearer(),
      });
    } else if (roll < 0.72 && phase1Keys.length > 0) {
      push({
        actor: "U",
        kind: "finalize",
        permitRef: prng.int(0, phase1Keys.length - 1),
        outcome: FINALIZE_OUTCOMES[prng.int(0, FINALIZE_OUTCOMES.length - 1)],
        delayMs: delay(),
        bearer: bearer(),
      });
    } else if (roll < 0.85 && phase1Keys.length > 0) {
      push({
        actor: "U",
        kind: "sync",
        permitRef: prng.int(0, phase1Keys.length - 1),
        outcome: prng.next() < 0.75 ? "scored" : "low_confidence",
        delayMs: delay(),
        bearer: bearer(),
      });
    } else {
      push({ actor: "U", kind: "access", delayMs: delay(), bearer: bearer() });
    }
  }
  if (cancels > 0) features.push("cancel-during-call");
  if (withRefresh) push({ actor: "U", kind: "refresh", delayMs: delay(), bearer: "original" });
  if (withLogout) push({ actor: "U", kind: "logout", delayMs: delay(), bearer: "original" });
  if (withClockJump) {
    push({
      actor: "U",
      kind: "skew",
      delayMs: delay(),
      skewMs: [-600_000, 600_000, 3_000_000, 3_700_000][prng.int(0, 3)],
      bearer: "original",
    });
  }
  if (withV) {
    const m = prng.int(2, 6);
    for (let i = 0; i < m; i++) {
      if (phase1Keys.length > 0 && prng.next() < 0.4) {
        push({
          actor: "V",
          kind: "finalize",
          permitRef: prng.int(0, phase1Keys.length - 1),
          outcome: "cancelled",
          foreignPermit: true,
          delayMs: delay(),
          bearer: "original",
        });
      } else {
        push({
          actor: "V",
          kind: "reserve",
          key: prng.next() < 0.7 ? pool[prng.int(0, poolSize - 1)] : prng.uuid(),
          delayMs: delay(),
          bearer: "original",
        });
      }
    }
  }
  // Cancelled reserves are retried once with the SAME key after the burst.
  assert(reserves + cancels + phase1Keys.length <= PERMITS_BUDGET, "plan exceeds permits budget");
  return { premium, features, phase1Keys, ops, withV, spreadMs, bearerExpOffsetMs };
}

async function runIteration(h: XcHarness, iteration: number, seed: number): Promise<IterationRow> {
  const prng = new Prng(seed);
  h.fake.reset(seed, STRESS_LATENCY_MS);
  clockSkewMs = 0;
  const p = plan(prng);
  // One /24 per iteration index: the edge fn's in-memory per-IP and
  // auth-failure windows outlive fake.reset(), so iterations must never
  // share an address (a replay is a fresh process, so index 0 is fine).
  const ipBase = `10.${(iteration >>> 8) & 255}.${iteration & 255}`;
  const ipFor = (lane: number) => `${ipBase}.${lane & 255}`;
  h.upstreamCalls.length = 0;
  const t0 = performance.now();
  const results: OpResult[] = [];
  const violated: string[] = [];
  const detail: Record<string, unknown> = {};
  const replay = `STRESS_REPLAY_SEED=${seed} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json stress_analysis_permits_concurrency.test.ts --filter "stress permits: seeded"`;

  const finish = (outcome: IterationRow["outcome"]): IterationRow => ({
    seed,
    iteration,
    outcome,
    features: p.features,
    premium: p.premium,
    requests: results.length,
    statusHistogram: histogram(
      results.map((r) => `${r.actor}.${r.kind}:${r.status}${r.code ? `:${r.code}` : ""}`),
    ),
    durationMs: Math.round(performance.now() - t0),
    violated,
    replay,
    detail: outcome === "HELD" ? undefined : { ...detail, results, timeline: h.fake.timeline },
  });

  const body = async (): Promise<void> => {
    // ── actors ──
    const bootU = await bootstrap(h, prng.uuid(), ipFor(250));
    if (bootU.status !== 200) {
      violated.push(`bootstrap U → ${bootU.status}`);
      return;
    }
    const subOf = (token: string): string => {
      const sid = h.fake.accessIndex.get(token);
      return sid ? h.fake.sessions.get(sid)!.userId : "";
    };
    const U: ActorState = {
      sub: subOf(bootU.accessToken),
      ip: ipFor(251),
      original: bootU.accessToken,
      latest: bootU.accessToken,
      refreshToken: bootU.refreshToken,
      logoutStartedAt: null,
      loggedOutAt: null,
    };
    if (!U.sub) {
      violated.push("bootstrap U minted no session");
      return;
    }
    if (p.premium) {
      h.fake.tables.billing_entitlements.push({
        user_id: U.sub,
        premium: true,
        product_key: "pickle_sensei_pro_annual",
        expires_at: null,
        verified_at: new Date().toISOString(),
      });
    }
    let V: ActorState | null = null;
    if (p.withV) {
      const bootV = await bootstrap(h, prng.uuid(), ipFor(252));
      if (bootV.status !== 200) {
        violated.push(`bootstrap V → ${bootV.status}`);
        return;
      }
      V = {
        sub: subOf(bootV.accessToken),
        ip: ipFor(253),
        original: bootV.accessToken,
        latest: bootV.accessToken,
        refreshToken: bootV.refreshToken,
        logoutStartedAt: null,
        loggedOutAt: null,
      };
    }
    if (p.bearerExpOffsetMs !== null) {
      U.original = skewedBearer(h, U.original, p.bearerExpOffsetMs);
      U.latest = U.original;
    }

    // ── phase 1: permits the burst will race on ──
    const phase1: string[] = [];
    for (const key of p.phase1Keys) {
      const res = await h.handler(
        edgeRequest("POST", "/v1/analysis-permits", {
          token: U.original,
          ip: U.ip,
          body: { idempotencyKey: key },
        }),
      );
      const json = await readJson(res);
      const permit = json.permit as Record<string, unknown> | undefined;
      if (res.status !== 200 || !permit?.id) {
        // A skewed bearer that is already expired on the edge clock is
        // legitimately refused; the burst then runs without phase-1 permits.
        const exp = jwtPayload(U.original)?.exp;
        if (res.status === 401 && typeof exp === "number" && exp * 1000 <= Date.now()) {
          break;
        }
        violated.push(`phase1 reserve ${key} → ${res.status}`);
        return;
      }
      phase1.push(String(permit.id));
    }
    detail.phase1Permits = phase1;

    // ── the burst ──
    const fire = async (op: Op): Promise<void> => {
      await sleep(op.delayMs);
      const actor = op.actor === "U" ? U : V!;
      const token = op.bearer === "latest" ? actor.latest : actor.original;
      const startedAt = performance.now();
      const startedEpochMs = Date.now();
      const exp = jwtPayload(token)?.exp;
      const record = (status: number, code?: string, permitId?: string) =>
        results.push({
          lane: op.lane,
          actor: op.actor,
          kind: op.kind,
          key: op.key,
          permitRef: op.permitRef,
          cancel: op.cancel,
          status,
          code,
          permitId,
          startedAt: Math.round(startedAt * 100) / 100,
          endedAt: Math.round(performance.now() * 100) / 100,
          startedEpochMs,
          endedEpochMs: Date.now(),
          bearerExp: typeof exp === "number" ? exp : undefined,
        });
      const codeOf = (json: Record<string, unknown>) => {
        const err = json.error;
        return err && typeof err === "object"
          ? String((err as Record<string, unknown>).code ?? "")
          : undefined;
      };
      if (op.kind === "skew") {
        clockSkewMs = op.skewMs ?? 0;
        detail.clockJumpAt = Math.round(performance.now() * 100) / 100;
        detail.clockJumpMs = op.skewMs;
        record(0, "clock-jump");
        return;
      }
      if (op.kind === "refresh") {
        const res = await h.handler(
          edgeRequest("POST", "/v1/auth/refresh", {
            ip: ipFor(200 + op.lane),
            body: { refreshToken: actor.refreshToken },
          }),
        );
        const json = await readJson(res);
        const session = json.session as Record<string, unknown> | undefined;
        if (res.status === 200 && session) {
          actor.latest = String(session.accessToken);
          actor.refreshToken = String(session.refreshToken);
        }
        record(res.status, codeOf(json));
        return;
      }
      if (op.kind === "logout") {
        actor.logoutStartedAt = startedAt;
        const res = await h.handler(
          edgeRequest("POST", "/v1/auth/logout", { token, ip: actor.ip }),
        );
        if (res.status === 204 || res.status === 200) {
          actor.loggedOutAt = performance.now();
        }
        record(res.status, codeOf(await readJson(res)));
        return;
      }
      if (op.kind === "access") {
        const res = await h.handler(edgeRequest("GET", "/v1/me/access", { token, ip: actor.ip }));
        const json = await readJson(res);
        if (res.status === 200) {
          violated.push(...accessInvariantViolations(json, p.premium, `lane ${op.lane} access`));
        }
        record(res.status, codeOf(json));
        return;
      }
      if (op.kind === "finalize") {
        const permitId = phase1[op.permitRef ?? 0];
        if (!permitId) return;
        const res = await h.handler(
          edgeRequest("POST", `/v1/analysis-permits/${permitId}/finalize`, {
            token,
            ip: actor.ip,
            body: { outcome: op.outcome, ratingId: null },
          }),
        );
        const json = await readJson(res);
        record(res.status, codeOf(json), permitId);
        if (op.foreignPermit && res.status !== 404 && res.status !== 401) {
          violated.push(`lane ${op.lane}: V finalizing U's permit → ${res.status} (expected 404)`);
        }
        return;
      }
      if (op.kind === "sync") {
        const permitId = phase1[op.permitRef ?? 0];
        if (!permitId) return;
        const shotId = prng.uuid();
        const res = await h.handler(
          edgeRequest("POST", "/v1/shots:sync", {
            token,
            ip: actor.ip,
            body: {
              shots: [
                syncShotPayload(shotId, permitId, {
                  resultKind: op.outcome,
                  ...(op.outcome === "low_confidence" ? { overallScore: null } : {}),
                }),
              ],
            },
          }),
        );
        const json = await readJson(res);
        const acc = (json.acceptedIds ?? []) as string[];
        const rej = (json.rejected ?? []) as Array<{ id: string; code: string }>;
        record(
          res.status,
          acc.includes(shotId)
            ? "accepted"
            : (rej.find((r) => r.id === shotId)?.code ?? codeOf(json)),
          permitId,
        );
        return;
      }
      // reserve — optionally abandoned by the client while the server runs
      const controller = new AbortController();
      const request = new Request(
        edgeRequest("POST", "/v1/analysis-permits", {
          token,
          ip: actor.ip,
          body: { idempotencyKey: op.key },
        }),
        { signal: controller.signal },
      );
      const serverSide = h.handler(request);
      if (op.cancel) {
        await sleep(prng.int(0, 3));
        controller.abort(new DOMException("client cancelled", "AbortError"));
      }
      const res = await serverSide;
      const json = await readJson(res);
      const permit = json.permit as Record<string, unknown> | undefined;
      if (res.status === 200) {
        violated.push(
          ...accessInvariantViolations(
            json.access as Record<string, unknown> | undefined,
            op.actor === "U" ? p.premium : false,
            `lane ${op.lane} reserve.access`,
          ),
        );
        if (!permit?.id) violated.push(`lane ${op.lane}: 200 without permit id`);
      }
      record(res.status, codeOf(json), permit?.id ? String(permit.id) : undefined);
      if (op.cancel) {
        // The client never saw the reply and retries with the SAME key.
        const retryStartedAt = performance.now();
        const retryStartedEpochMs = Date.now();
        const retry = await h.handler(
          edgeRequest("POST", "/v1/analysis-permits", {
            token,
            ip: actor.ip,
            body: { idempotencyKey: op.key },
          }),
        );
        const rjson = await readJson(retry);
        const rpermit = rjson.permit as Record<string, unknown> | undefined;
        results.push({
          lane: op.lane,
          actor: op.actor,
          kind: "reserve",
          key: op.key,
          cancel: false,
          status: retry.status,
          code: codeOf(rjson),
          permitId: rpermit?.id ? String(rpermit.id) : undefined,
          startedAt: Math.round(retryStartedAt * 100) / 100,
          endedAt: Math.round(performance.now() * 100) / 100,
          startedEpochMs: retryStartedEpochMs,
          endedEpochMs: Date.now(),
          bearerExp: typeof exp === "number" ? exp : undefined,
        });
        if (res.status === 200 && retry.status === 200 && rpermit?.id !== permit?.id) {
          violated.push(
            `lane ${op.lane}: cancelled reserve got ${permit?.id}, same-key retry got ${rpermit?.id}`,
          );
        }
        if (res.status === 200 && retry.status !== 200 && retry.status !== 401) {
          violated.push(`lane ${op.lane}: same-key retry after cancel → ${retry.status}`);
        }
      }
    };
    await Promise.all(p.ops.map(fire));
    clockSkewMs = 0;

    // ── invariants over the server's state ──
    const rowsU = h.fake.tables.analysis_permits.filter((r) => r.user_id === U.sub);
    const rowsV = V ? h.fake.tables.analysis_permits.filter((r) => r.user_id === V!.sub) : [];
    const shotsU = h.fake.tables.shots.filter((s) => s.user_id === U.sub);
    const nowMs = Date.now();
    const live = (r: Record<string, unknown>) =>
      r.status === "reserved" && new Date(String(r.created_at)).getTime() > nowMs - 24 * 3600_000;
    const scoredU = shotsU.filter((s) => s.result_kind === "scored").length;
    const liveU = rowsU.filter(live).length;

    for (const r of results) {
      if (r.status >= 500) violated.push(`lane ${r.lane} ${r.kind}: ${r.status} (5xx)`);
      if (r.status === 429) violated.push(`lane ${r.lane} ${r.kind}: 429 under budget`);
      if (r.kind === "reserve" && r.status === 200) {
        const row = (r.actor === "U" ? rowsU : rowsV).find((x) => x.id === r.permitId);
        if (!row) violated.push(`lane ${r.lane}: 200 permit ${r.permitId} has no row`);
        else if (row.idempotency_key !== r.key) {
          violated.push(
            `lane ${r.lane}: permit ${r.permitId} row key ${row.idempotency_key} ≠ ${r.key}`,
          );
        }
      }
      if (r.kind === "reserve" && r.status === 402 && r.code !== "access.paywall_required") {
        violated.push(`lane ${r.lane}: 402 with code ${r.code}`);
      }
      if (r.kind === "reserve" && r.status === 402 && r.actor === "U" && p.premium) {
        violated.push(`lane ${r.lane}: premium user paywalled`);
      }
      if (r.kind === "reserve" && ![200, 401, 402].includes(r.status)) {
        violated.push(`lane ${r.lane}: reserve → ${r.status} ${r.code ?? ""}`);
      }
      const actor = r.actor === "U" ? U : V!;
      const authenticatedOp =
        r.kind === "reserve" || r.kind === "finalize" || r.kind === "sync" || r.kind === "access";
      const expMs = (r.bearerExp ?? Infinity) * 1000;
      if (r.status === 401 && authenticatedOp) {
        // A 401 needs a cause that was in flight: a logout issued before this
        // request was answered, or a bearer that was expired on the edge
        // clock at some point while the request was open (clock skew / clock
        // jump — a backwards jump can revive a bearer that was expired at
        // issue time, so both ends of the window count).
        const logoutInFlight = actor.logoutStartedAt !== null && actor.logoutStartedAt <= r.endedAt;
        const expiredBeforeAnswer = expMs <= r.endedEpochMs || expMs <= r.startedEpochMs;
        if (!logoutInFlight && !expiredBeforeAnswer) {
          violated.push(`lane ${r.lane} ${r.kind}: 401 with no logout/expiry in flight`);
        }
      }
      // A bearer expired on the edge clock for the whole request must never be served.
      if (
        authenticatedOp &&
        r.status !== 401 &&
        expMs <= Math.min(r.startedEpochMs, r.endedEpochMs)
      ) {
        violated.push(
          `lane ${r.lane} ${r.kind}: ${r.status} served with bearer expired at ${expMs}`,
        );
      }
      // After a completed logout, nothing on that session may be served.
      if (
        authenticatedOp &&
        actor.loggedOutAt !== null &&
        r.startedAt >= actor.loggedOutAt &&
        r.status !== 401
      ) {
        violated.push(`lane ${r.lane} ${r.kind}: ${r.status} served after logout completed`);
      }
    }
    // idempotency: one permit id per (user,key); one row per (user,key)
    for (const [who, rows] of [
      ["U", rowsU],
      ["V", rowsV],
    ] as Array<[Actor, typeof rowsU]>) {
      const keys = new Set(rows.map((r) => r.idempotency_key));
      if (keys.size !== rows.length) violated.push(`${who}: duplicate (user,key) rows`);
      const ids = new Set(rows.map((r) => r.id));
      if (ids.size !== rows.length) violated.push(`${who}: duplicate permit ids`);
      const byKey = new Map<string, Set<string>>();
      for (const r of results) {
        if (r.kind === "reserve" && r.actor === who && r.status === 200 && r.key) {
          byKey.set(r.key, (byKey.get(r.key) ?? new Set()).add(String(r.permitId)));
        }
      }
      for (const [key, set] of byKey) {
        if (set.size !== 1) violated.push(`${who}: key ${key} → ${set.size} permit ids`);
      }
      const served = new Set(
        results
          .filter((r) => r.kind === "reserve" && r.actor === who && r.status === 200)
          .map((r) => r.permitId),
      );
      for (const row of rows) {
        if (!p.phase1Keys.includes(String(row.idempotency_key)) && !served.has(String(row.id))) {
          violated.push(`${who}: row ${row.id} was never returned by a 200 (lost update)`);
        }
      }
    }
    // cross-actor isolation
    if (V) {
      const idsU = new Set(rowsU.map((r) => r.id));
      for (const r of results) {
        if (r.actor === "V" && r.kind === "reserve" && r.permitId && idsU.has(r.permitId)) {
          violated.push(`V received U's permit ${r.permitId}`);
        }
      }
      for (const permitId of phase1) {
        const row = rowsU.find((r) => r.id === permitId)!;
        const vWins = results.filter(
          (r) =>
            r.actor === "V" && r.kind === "finalize" && r.permitId === permitId && r.status === 200,
        );
        if (vWins.length > 0) violated.push(`V finalized U's permit ${permitId}`);
        if (row.outcome === "cancelled") {
          const uCancelled = results.some(
            (r) =>
              r.actor === "U" &&
              r.kind === "finalize" &&
              r.permitId === permitId &&
              r.status === 200,
          );
          if (!uCancelled) violated.push(`permit ${permitId} cancelled without a U 200`);
        }
      }
    }
    // no double spend
    if (!p.premium && scoredU + liveU > 2) {
      violated.push(`double spend: scored=${scoredU} liveReserved=${liveU}`);
    }
    if (!p.premium && scoredU > 2) violated.push(`lifetime scored=${scoredU}`);
    // settled permits: exactly one terminal outcome, consistent with shots
    for (const permitId of phase1) {
      const row = rowsU.find((r) => r.id === permitId);
      if (!row) {
        violated.push(`phase1 permit ${permitId} vanished`);
        continue;
      }
      const shots = shotsU.filter((s) => s.analysis_permit_id === permitId);
      if (shots.length > 1) violated.push(`permit ${permitId}: ${shots.length} shots`);
      if (shots.length === 1) {
        if (row.status === "reserved" || row.outcome !== shots[0].result_kind) {
          violated.push(
            `permit ${permitId}: shot ${shots[0].result_kind} but permit ${row.status}/${row.outcome}`,
          );
        }
      }
      const winners = results.filter(
        (r) =>
          r.permitId === permitId &&
          r.actor === "U" &&
          ((r.kind === "sync" && r.code === "accepted") ||
            (r.kind === "finalize" && r.status === 200)),
      );
      const outcomes = new Set(
        winners.map((w) =>
          w.kind === "sync"
            ? p.ops.find((o) => o.lane === w.lane)?.outcome
            : p.ops.find((o) => o.lane === w.lane)?.outcome,
        ),
      );
      // Idempotent replays of the winning outcome are 200 too; a SECOND
      // distinct outcome accepted for one permit is a lost update.
      if (outcomes.size > 1) {
        violated.push(`permit ${permitId}: outcomes ${[...outcomes].join(",")} both accepted`);
      }
      if (winners.length > 0 && row.status === "reserved") {
        violated.push(`permit ${permitId}: winner recorded but row still reserved`);
      }
      if (winners.length > 0 && !outcomes.has(String(row.outcome))) {
        violated.push(`permit ${permitId}: row outcome ${row.outcome} ≠ accepted ${[...outcomes]}`);
      }
      const shotAccepted = results.some(
        (r) => r.permitId === permitId && r.kind === "sync" && r.code === "accepted",
      );
      if (shotAccepted && shots.length !== 1) {
        violated.push(`permit ${permitId}: sync accepted but ${shots.length} shot rows`);
      }
    }
    // final access read must agree with the rows (fresh session: U may have logged out)
    const probe =
      U.loggedOutAt !== null || p.bearerExpOffsetMs !== null
        ? (await bootstrap(h, U.sub, ipFor(254))).accessToken
        : U.latest;
    const finalRes = await h.handler(
      edgeRequest("GET", "/v1/me/access", { token: probe, ip: ipFor(254) }),
    );
    const finalJson = await readJson(finalRes);
    if (finalRes.status !== 200) {
      violated.push(`final access → ${finalRes.status}`);
    } else {
      violated.push(...accessInvariantViolations(finalJson, p.premium, "final access"));
      const fr = (finalJson.freeRatings ?? {}) as Record<string, number>;
      const used = Math.min(2, scoredU);
      const remaining = 2 - used;
      if (fr.used !== used) violated.push(`final access used=${fr.used} scored=${scoredU}`);
      if (fr.reserved !== Math.min(liveU, remaining)) {
        violated.push(
          `final access reserved=${fr.reserved} liveRows=${liveU} remaining=${remaining}`,
        );
      }
      detail.finalAccess = finalJson.freeRatings;
    }
    detail.rowsU = rowsU.map((r) => ({
      id: r.id,
      key: r.idempotency_key,
      status: r.status,
      outcome: r.outcome,
    }));
    detail.rowsV = rowsV.length;
    detail.scoredU = scoredU;
  };

  let timedOut = false;
  let timer: number | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, STRESS_ITER_TIMEOUT_MS);
  });
  try {
    await Promise.race([body(), timeout]);
  } catch (error) {
    violated.push(`threw: ${String(error)}`);
  } finally {
    clearTimeout(timer);
    clockSkewMs = 0;
  }
  if (timedOut) {
    violated.push(`iteration exceeded ${STRESS_ITER_TIMEOUT_MS}ms (deadlock / unbounded wait)`);
    return finish("TIMEOUT");
  }
  return finish(violated.length === 0 ? "HELD" : "BROKEN");
}

Deno.test("stress permits: seeded concurrency campaign — every iteration HELD", async () => {
  const h = await loadXcHarness();
  const seeds =
    REPLAY_SEED > 0
      ? [REPLAY_SEED]
      : Array.from({ length: STRESS_ITER }, (_, i) => iterationSeed(STRESS_SEED, i));
  const table: IterationRow[] = [];
  const t0 = performance.now();
  const restoreClock = installClock();
  try {
    for (let i = 0; i < seeds.length; i++) {
      const row = await runIteration(h, i, seeds[i]);
      table.push(row);
      if (row.outcome !== "HELD") {
        console.log(`[stress] seed=${row.seed} ${row.outcome}: ${row.violated.join(" | ")}`);
      }
    }
  } finally {
    restoreClock();
  }
  const features = histogram(table.flatMap((r) => r.features));
  const summary = {
    unit: "route-post-v1-analysis-permits",
    lens: "concurrency",
    plane: "linux/deno in-process real handler over xc_concurrency_harness fake",
    baseSeed: STRESS_SEED,
    iterations: table.length,
    requests: table.reduce((n, r) => n + r.requests, 0),
    held: table.filter((r) => r.outcome === "HELD").length,
    broken: table.filter((r) => r.outcome === "BROKEN").map((r) => r.seed),
    timedOut: table.filter((r) => r.outcome === "TIMEOUT").map((r) => r.seed),
    features,
    statusHistogram: table.reduce<Record<string, number>>((acc, r) => {
      for (const [k, v] of Object.entries(r.statusHistogram)) acc[k] = (acc[k] ?? 0) + v;
      return acc;
    }, {}),
    durationMs: Math.round(performance.now() - t0),
    maxIterationMs: Math.max(...table.map((r) => r.durationMs)),
    latencyMs: STRESS_LATENCY_MS,
    heap: Deno.memoryUsage(),
    table,
  };
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}stress_analysis_permits_edge.json`;
  await Deno.writeTextFile(path, JSON.stringify(summary, null, 2));
  console.log(
    `[stress] ${summary.iterations} iterations / ${summary.requests} requests in ${summary.durationMs}ms — held=${summary.held} broken=${summary.broken.length} timedOut=${summary.timedOut.length} → ${path}`,
  );
  console.log(`[stress] features: ${JSON.stringify(features)}`);
  assertEquals(
    [...summary.broken, ...summary.timedOut],
    [],
    `BROKEN/TIMEOUT seeds — replay each with STRESS_REPLAY_SEED=<seed> (see ${path})`,
  );
  assert(summary.iterations === seeds.length, "every planned iteration ran");
});

// ─────────────────────────────────────────────────────────────────────────────
// Client cancel → retry with a FRESH key (what apps/mobile/src/analysis/
// runCaptureAnalysis.ts:331 does: `permits.reserve(makeUuid())` on every
// attempt). The route contract holds — one row per key, ≤ 2 live holds — so
// this pins the observable consequence rather than a defect in the route:
// two abandoned calls park both free slots for PERMIT_LIFETIME_HOURS.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress permits: two client-cancelled reserves with fresh keys leave used=0 but paywall the third",
  async () => {
    const h = await loadXcHarness();
    const seed = iterationSeed(STRESS_SEED, 0x7fff);
    h.fake.reset(seed, STRESS_LATENCY_MS);
    const prng = new Prng(seed);
    const ip = `10.${(seed >>> 24) & 255}.${(seed >>> 16) & 255}.9`;
    const boot = await bootstrap(h, prng.uuid(), ip);
    assertEquals(boot.status, 200);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const request = new Request(
        edgeRequest("POST", "/v1/analysis-permits", {
          token: boot.accessToken,
          ip,
          body: { idempotencyKey: prng.uuid() },
        }),
        { signal: controller.signal },
      );
      const pending = h.handler(request);
      if (attempt < 2) controller.abort(new DOMException("client timeout", "AbortError"));
      statuses.push((await pending).status);
    }
    const access = await readJson(
      await h.handler(edgeRequest("GET", "/v1/me/access", { token: boot.accessToken, ip })),
    );
    const fr = access.freeRatings as Record<string, number>;
    const sub = h.fake.sessions.get(h.fake.accessIndex.get(boot.accessToken)!)!.userId;
    const rows = h.fake.tables.analysis_permits.filter((r) => r.user_id === sub);
    console.log(
      `[stress] cancel-retry-fresh-key: statuses=${JSON.stringify(statuses)} rows=${rows.length} access=${JSON.stringify(fr)}`,
    );
    // Route contract (HELD): the abandoned calls each reserved one row, the
    // third is refused, nothing was double-spent.
    assertEquals(statuses, [200, 200, 402]);
    assertEquals(rows.length, 2);
    assertEquals(rows.filter((r) => r.status === "reserved").length, 2);
    assertEquals(fr.used, 0);
    assertEquals(fr.reserved, 2);
    assertEquals(fr.availableToReserve, 0);
    assertEquals(access.canStartRating, false);
  },
);
