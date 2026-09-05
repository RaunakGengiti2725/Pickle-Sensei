/**
 * stress — POST /webhooks/revenuecat, lens CONCURRENCY.
 *
 * Each ITERATION is one seeded plan (seed = STRESS_SEED + i) delivered as a
 * single Promise.all burst against the REAL handler, then replayed:
 *
 *   dup        N copies of the same event id for user A (duplicate delivery)
 *   flip       a second event for A while RevenueCat's truth for A CHANGES
 *              between answers (purchase / refund / renewal / lifetime)
 *   transfer   TRANSFER A→B and B→A copies (two actors, two rows, both orders)
 *   orphan     event for a user with NO profiles row (FK target missing)
 *   outage     event whose first RevenueCat answers are a 503 or an aborted
 *              fetch (cancel-during-call); later answers succeed
 *   anon       $RCAnonymousID subscriber (nothing to verify)
 *   skew       RevenueCat expiry within ±1.5 s of now (clock-skew boundary)
 *   replay     every event id once more, sequentially, after the burst
 *
 * Invariants per iteration (BROKEN ones fail the test after the report is
 * written, so the artifact always exists):
 *   • statuses: 200 everywhere except a 503 per RevenueCat outage/abort; no
 *     other 4xx/5xx, no 429 (each iteration has its own /24 source IP);
 *   • idempotency: exactly one audit row per event id acknowledged 200, none
 *     for an id that only ever failed; audit row carries the event's type;
 *   • no duplicate / no phantom billing rows: exactly one per verified user,
 *     none for the orphan;
 *   • no lost update: the surviving billing row is the FRESHEST RevenueCat
 *     verdict delivered for that user (RevenueCat reads its truth when it
 *     answers, so a later answer is never staler);
 *   • replay: an acknowledged id short-circuits (duplicate:true, no
 *     RevenueCat call); a never-acknowledged id is fully re-processed;
 *   • no deadlock: the burst settles within STRESS_BURST_TIMEOUT_MS;
 *   • the route only ever talks to RevenueCat and the two service-role
 *     tables (no unexpected upstream call).
 *
 * Report: <STRESS_OUT_DIR>/{memory,postgres}/iterations.json (seed → outcome,
 * every request, every RevenueCat answer, final rows) + summary.json.
 *
 * Replay a seed: STRESS_SEED=<seed> STRESS_ITER=1 deno test -A --no-check
 * --config deno.json stress_webhook_revenuecat_concurrency.test.ts
 * Postgres half: ./xc_pg_up.sh, then STRESS_PG_URL=<printed url> …
 */
import { assert, assertEquals } from "@std/assert";
import { Prng } from "./xc_concurrency_harness.ts";
import {
  type Backend,
  type BillingRow,
  loadStressHarness,
  MemoryBackend,
  muteRouteConsole,
  PostgresBackend,
  readJson,
  type RcCall,
  seededLatency,
  sleep,
  STRESS_BURST_TIMEOUT_MS,
  STRESS_ITER,
  STRESS_LATENCY_MS,
  STRESS_SEED,
  type Verdict,
  webhookRequest,
  writeJson,
} from "./stress_webhook_revenuecat_harness.ts";

const PG_URL = Deno.env.get("STRESS_PG_URL") ?? Deno.env.get("XC_PG_URL") ?? "";

// ── Plan ─────────────────────────────────────────────────────────────────────

type EventKind =
  "dup" | "flip" | "transfer-ab" | "transfer-ba" | "orphan" | "outage" | "anon" | "skew";

interface PlannedEvent {
  kind: EventKind;
  id: string;
  type: string;
  subjects: string[];
  copies: number;
  body: Record<string, unknown>;
}

interface Plan {
  seed: number;
  iteration: number;
  ip: string;
  users: { a: string; b: string; orphan: string; outage: string; skew: string };
  truth: Record<string, Verdict[]>;
  flipPattern: string;
  outagePattern: string;
  skewMs: number;
  events: PlannedEvent[];
  /** lane order + start jitter (ms) — the seeded schedule */
  lanes: Array<{ lane: number; event: number; jitterMs: number }>;
}

const DAY = 86_400_000;

function premium(tag: string, expiresAt: string | null): Verdict {
  return { kind: "premium", tag, expiresAt, productId: tag };
}
const free = (): Verdict => ({ kind: "free", tag: "free" });

function plan(seed: number, iteration: number): Plan {
  const prng = new Prng(seed);
  const users = {
    a: prng.uuid(),
    b: prng.uuid(),
    orphan: prng.uuid(),
    outage: prng.uuid(),
    skew: prng.uuid(),
  };
  const nowMs = Date.now();
  const inDays = (d: number) => new Date(nowMs + d * DAY).toISOString();

  const flipPatterns: Array<[string, Verdict[]]> = [
    ["purchase: free → premium", [free(), premium("a-monthly", inDays(30))]],
    ["refund: premium → free", [premium("a-monthly", inDays(30)), free()]],
    [
      "renewal: expiry extends",
      [premium("a-monthly", inDays(1)), premium("a-monthly-renewed", inDays(31))],
    ],
    [
      "upgrade: monthly → lifetime",
      [premium("a-monthly", inDays(30)), premium("a-lifetime", null)],
    ],
    [
      "lapse then repurchase",
      [premium("a-monthly", inDays(30)), free(), premium("a-annual", inDays(365))],
    ],
  ];
  const [flipPattern, aTruth] = flipPatterns[prng.int(0, flipPatterns.length - 1)];

  const outagePatterns: Array<[string, Verdict[]]> = [
    ["first answer 503", [{ kind: "outage", tag: "outage" }, premium("d-monthly", inDays(30))]],
    ["first answer aborted", [{ kind: "abort", tag: "abort" }, premium("d-monthly", inDays(30))]],
    [
      "two answers 503",
      [{ kind: "outage", tag: "outage" }, { kind: "outage", tag: "outage" }, free()],
    ],
    ["every answer 503 (recovers at replay)", [{ kind: "outage", tag: "outage" }]],
  ];
  const [outagePattern, dTruth] = outagePatterns[prng.int(0, outagePatterns.length - 1)];

  const skewMs = prng.int(-1500, 1500);
  const truth: Record<string, Verdict[]> = {
    [users.a]: aTruth,
    [users.b]: prng.int(0, 1) ? [premium("b-annual", inDays(300))] : [free()],
    [users.orphan]: [premium("c-monthly", inDays(30))],
    [users.outage]: dTruth,
    [users.skew]: [premium("s-monthly", new Date(nowMs + skewMs).toISOString())],
  };

  const id = (kind: string) => `stress-${seed}-${kind}-${prng.uuid().slice(0, 8)}`;
  const events: PlannedEvent[] = [];
  const push = (
    kind: EventKind,
    type: string,
    subjects: string[],
    copies: number,
    body: Record<string, unknown>,
  ) => {
    if (copies <= 0) return;
    const eventId = id(kind);
    events.push({
      kind,
      id: eventId,
      type,
      subjects,
      copies,
      body: { id: eventId, type, ...body },
    });
  };
  push("dup", "INITIAL_PURCHASE", [users.a], prng.int(2, 8), {
    app_user_id: users.a,
    product_id: "pickle_sensei_pro_monthly",
    entitlement_ids: ["pickle_sensei_pro"],
  });
  push("flip", "RENEWAL", [users.a], prng.int(1, 4), {
    app_user_id: users.a,
    product_id: "pickle_sensei_pro_monthly",
  });
  push("transfer-ab", "TRANSFER", [users.a, users.b], prng.int(1, 3), {
    transferred_from: [users.a],
    transferred_to: [users.b],
  });
  push("transfer-ba", "TRANSFER", [users.b, users.a], prng.int(0, 2), {
    transferred_from: [users.b],
    transferred_to: [users.a],
  });
  push("orphan", "INITIAL_PURCHASE", [users.orphan], prng.int(1, 3), { app_user_id: users.orphan });
  push("outage", "RENEWAL", [users.outage], prng.int(1, 4), { app_user_id: users.outage });
  push("anon", "INITIAL_PURCHASE", [], prng.int(1, 2), {
    app_user_id: `$RCAnonymousID:${prng.uuid().replace(/-/g, "")}`,
    aliases: [`$RCAnonymousID:${prng.uuid().replace(/-/g, "")}`],
  });
  push("skew", "RENEWAL", [users.skew], prng.int(1, 3), { app_user_id: users.skew });

  const laneList = events.flatMap((e, ei) => Array.from({ length: e.copies }, () => ei));
  const lanes = prng
    .shuffle(laneList)
    .map((event, lane) => ({ lane, event, jitterMs: prng.int(0, STRESS_LATENCY_MS * 2) }));

  return {
    seed,
    iteration,
    ip: `10.${(iteration >> 16) & 255}.${(iteration >> 8) & 255}.${iteration & 255}`,
    users,
    truth,
    flipPattern,
    outagePattern,
    skewMs,
    events,
    lanes,
  };
}

// ── Execution ────────────────────────────────────────────────────────────────

interface LaneRow {
  lane: number;
  eventId: string;
  kind: EventKind;
  status: number;
  duplicate: boolean;
  verified: boolean | null;
  startedAt: number;
  endedAt: number;
}

interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
}

interface IterationReport {
  seed: number;
  iteration: number;
  backend: string;
  outcome: "HELD" | "BROKEN";
  wallMs: number;
  requests: number;
  plan: Omit<Plan, "lanes">;
  lanes: LaneRow[];
  rcCalls: Array<Omit<RcCall, "verdict"> & { verdict: string }>;
  replay: Array<{
    eventId: string;
    kind: EventKind;
    status: number;
    duplicate: boolean;
    rcCallsAdded: number;
  }>;
  billingFinal: BillingRow[];
  auditFinal: Array<{ id: string; event_type: string | null; app_user_id: string | null }>;
  observations: Record<string, unknown>;
  invariants: Invariant[];
  replayCommand: string;
}

const tagOf = (row: BillingRow): string => (row.premium ? (row.product_key ?? "premium") : "free");

async function runIteration(
  backend: Backend,
  seed: number,
  iteration: number,
  file: string,
): Promise<IterationReport> {
  const p = plan(seed, iteration);
  const { handler, world } = await loadStressHarness(backend);
  const { a, b, orphan, outage, skew } = p.users;
  await backend.reset(
    [a, b, outage, skew],
    [orphan],
    p.events.map((e) => e.id),
  );
  world.resetRecording();
  world.truth = new Map(Object.entries(p.truth));
  world.latency = seededLatency(new Prng((seed * 7919) >>> 0), STRESS_LATENCY_MS);

  const invariants: Invariant[] = [];
  const inv = (name: string, holds: boolean, detail: string) =>
    invariants.push({ name, holds, detail });

  // ── burst ──
  const rows: LaneRow[] = [];
  const t0 = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), STRESS_BURST_TIMEOUT_MS);
  });
  const burst = Promise.all(
    p.lanes.map(async ({ lane, event, jitterMs }) => {
      const e = p.events[event];
      await sleep(jitterMs);
      const startedAt = performance.now();
      const response = await handler(webhookRequest(e.body, { ip: p.ip }));
      const body = await readJson(response);
      rows.push({
        lane,
        eventId: e.id,
        kind: e.kind,
        status: response.status,
        duplicate: body.duplicate === true,
        verified: typeof body.verified === "boolean" ? body.verified : null,
        startedAt: Math.round((startedAt - t0) * 100) / 100,
        endedAt: Math.round((performance.now() - t0) * 100) / 100,
      });
    }),
  );
  const settled = await Promise.race([burst, timeout]);
  clearTimeout(timer);
  const wallMs = Math.round(performance.now() - t0);
  const deadlocked = settled === "timeout";
  inv(
    "no deadlock: burst settled within the bound",
    !deadlocked,
    `${wallMs}ms of ${STRESS_BURST_TIMEOUT_MS}ms, ${rows.length}/${p.lanes.length} lanes done`,
  );
  rows.sort((x, y) => x.lane - y.lane);
  const burstRc = world.rcCalls.slice();

  // ── statuses ──
  const outageAnswers = burstRc.filter(
    (c) => c.verdict?.kind === "outage" || c.verdict?.kind === "abort",
  ).length;
  const s503 = rows.filter((r) => r.status === 503);
  inv(
    "statuses: 200 everywhere, one 503 per RevenueCat outage/abort answer, nothing else",
    rows.every((r) => r.status === 200 || (r.status === 503 && r.kind === "outage")) &&
      s503.length === outageAnswers,
    `histogram=${JSON.stringify(histogram(rows.map((r) => `${r.kind}:${r.status}`)))} rcOutageAnswers=${outageAnswers}`,
  );
  inv(
    "no unexpected upstream call",
    world.unexpected.length === 0,
    world.unexpected.join("; ") || "none",
  );

  // ── idempotency / audit rows ──
  const audit = await backend.eventsFor(p.events.map((e) => e.id));
  const ackIds = new Set(rows.filter((r) => r.status === 200).map((r) => r.eventId));
  for (const e of p.events) {
    const mine = audit.filter((row) => row.id === e.id);
    const expected = ackIds.has(e.id) ? 1 : 0;
    inv(
      `audit: ${e.kind} id has exactly ${expected} row(s)`,
      mine.length === expected &&
        mine.every((row) => row.event_type === e.type && row.provider === "revenuecat"),
      `rows=${mine.length} type=${mine.map((m) => m.event_type).join(",")}`,
    );
  }

  // ── billing rows ──
  const billing = await backend.billingFor([a, b, orphan, outage, skew]);
  const rowsFor = (u: string) => billing.filter((row) => row.user_id === u);
  const verifiedFor = (u: string) =>
    burstRc.filter(
      (c) => c.user === u && c.verdict && c.verdict.kind !== "outage" && c.verdict.kind !== "abort",
    );
  for (const [label, u] of [
    ["a", a],
    ["b", b],
    ["outage", outage],
    ["skew", skew],
  ] as const) {
    const expected = verifiedFor(u).length > 0 ? 1 : 0;
    inv(
      `billing: user ${label} has exactly ${expected} row(s)`,
      rowsFor(u).length === expected,
      `rows=${rowsFor(u).length}`,
    );
  }
  // A 200 is either a processed copy ({verified}) or a short-circuited one
  // ({duplicate:true}); a copy that reached the seen-check after a sibling
  // wrote the audit row is legitimately the latter.
  const ackShape = (r: LaneRow) =>
    r.status === 200 && (r.duplicate ? r.verified === null : typeof r.verified === "boolean");
  inv(
    "every 200 is either {verified:boolean} or {duplicate:true}",
    rows.filter((r) => r.status === 200).every(ackShape),
    histogramText(
      rows
        .filter((r) => r.status === 200)
        .map((r) => (r.duplicate ? "duplicate" : `verified:${r.verified}`)),
    ),
  );
  inv(
    "billing: orphan (no profiles row) has NO row, and its processed copies were acknowledged verified:false",
    rowsFor(orphan).length === 0 &&
      rows
        .filter((r) => r.kind === "orphan")
        .every((r) => r.status === 200 && (r.duplicate || r.verified === false)),
    `rows=${rowsFor(orphan).length} statuses=${rows
      .filter((r) => r.kind === "orphan")
      .map((r) => `${r.status}/${r.duplicate ? "dup" : r.verified}`)
      .join(",")}`,
  );
  inv(
    "anon: processed copies acknowledged verified:false, no RevenueCat call for a non-uuid subject",
    rows
      .filter((r) => r.kind === "anon")
      .every((r) => r.status === 200 && (r.duplicate || r.verified === false)) &&
      burstRc.every(
        (c) =>
          c.user === a || c.user === b || c.user === orphan || c.user === outage || c.user === skew,
      ),
    `statuses=${rows
      .filter((r) => r.kind === "anon")
      .map((r) => `${r.status}/${r.duplicate ? "dup" : r.verified}`)
      .join(",")} rcUsers=${[...new Set(burstRc.map((c) => c.user.slice(0, 8)))].join(",")}`,
  );

  // ── freshest verdict wins (no lost update) ──
  // What the route must persist for an answer: a premium entitlement whose
  // expiry had already passed when RevenueCat answered is honestly `free`.
  // An expiry that passes within EXPIRY_MARGIN_MS after the answer is
  // ambiguous (the handler parses a few ms later) and is left to the
  // clock-skew invariant below.
  const EXPIRY_MARGIN_MS = 250;
  const effectiveTag = (c: RcCall): string | "ambiguous" => {
    const v = c.verdict!;
    if (v.kind !== "premium") return v.tag;
    if (v.expiresAt === null) return v.tag;
    const remaining = Date.parse(v.expiresAt) - c.wallDelivered;
    if (remaining <= 0) return "free";
    return remaining <= EXPIRY_MARGIN_MS ? "ambiguous" : v.tag;
  };
  const staleWinners: Record<string, unknown>[] = [];
  let ambiguousFreshest = 0;
  for (const [label, u] of [
    ["a", a],
    ["b", b],
    ["outage", outage],
    ["skew", skew],
  ] as const) {
    const delivered = verifiedFor(u);
    const row = rowsFor(u)[0];
    if (!delivered.length || !row) continue;
    const freshest = delivered.reduce((x, y) => (y.delivered > x.delivered ? y : x));
    const freshTag = effectiveTag(freshest);
    if (freshTag === "ambiguous") {
      ambiguousFreshest++;
      continue;
    }
    const holds = tagOf(row) === freshTag;
    if (!holds) {
      staleWinners.push({
        user: label,
        rowTag: tagOf(row),
        rowVerifiedAt: row.verified_at,
        freshestTag: freshTag,
        freshestDeliveredAt: freshest.tDelivered,
        verdictsDelivered: delivered.map((c) => `${c.verdict!.tag}@${c.tDelivered}`),
      });
    }
    inv(
      `no lost update: user ${label}'s row is the freshest RevenueCat verdict`,
      holds,
      `row=${tagOf(row)} freshest=${freshTag} (delivered ${delivered.map((c) => effectiveTag(c)).join(" → ")})`,
    );
  }

  // ── clock skew ──
  const skewRow = rowsFor(skew)[0];
  const skewDelivered = verifiedFor(skew);
  if (skewRow && skewDelivered.length) {
    const exp = skewRow.expires_at ? Date.parse(skewRow.expires_at) : NaN;
    const holds = skewRow.premium
      ? Number.isFinite(exp) && skewDelivered.some((c) => exp > c.wallDelivered)
      : new Date(
          p.truth[skew][0].kind === "premium"
            ? (p.truth[skew][0] as { expiresAt: string }).expiresAt
            : 0,
        ).getTime() <= Date.now();
    inv(
      "clock skew: premium only while RevenueCat's expiry is still ahead of the verifying clock",
      holds,
      `skewMs=${p.skewMs} premium=${skewRow.premium} expires_at=${skewRow.expires_at}`,
    );
  }

  // ── replay ──
  // RevenueCat is back for the replay: a never-acknowledged id must now be
  // processed to completion (the outage user's remaining sequence may still
  // hold 503s — that is the burst's story, not the replay's).
  const replay: IterationReport["replay"] = [];
  const outageEvent = p.events.find((e) => e.kind === "outage");
  if (outageEvent && !ackIds.has(outageEvent.id)) {
    world.truth.set(outage, [
      premium("d-monthly-recovered", new Date(Date.now() + 30 * DAY).toISOString()),
    ]);
  }
  for (const e of p.events) {
    const before = world.rcCalls.length;
    const response = await handler(webhookRequest(e.body, { ip: p.ip }));
    const body = await readJson(response);
    const added = world.rcCalls.length - before;
    replay.push({
      eventId: e.id,
      kind: e.kind,
      status: response.status,
      duplicate: body.duplicate === true,
      rcCallsAdded: added,
    });
    if (ackIds.has(e.id)) {
      inv(
        `replay: acknowledged ${e.kind} id short-circuits (duplicate:true, no RevenueCat call)`,
        response.status === 200 && body.duplicate === true && added === 0,
        `status=${response.status} duplicate=${body.duplicate} rcAdded=${added}`,
      );
    } else {
      inv(
        `replay: never-acknowledged ${e.kind} id is fully re-processed then logged`,
        response.status === 200 && body.duplicate !== true && added === e.subjects.length,
        `status=${response.status} duplicate=${body.duplicate} rcAdded=${added} subjects=${e.subjects.length}`,
      );
    }
  }
  const auditAfter = await backend.eventsFor(p.events.map((e) => e.id));
  inv(
    "after replay: exactly one audit row per event id",
    p.events.every((e) => auditAfter.filter((r) => r.id === e.id).length === 1),
    `rows=${auditAfter.length} events=${p.events.length}`,
  );
  const billingAfter = await backend.billingFor([a, b, orphan, outage, skew]);
  inv(
    "after replay: still one billing row per verified user, none for the orphan",
    [a, b, outage, skew].every((u) => billingAfter.filter((r) => r.user_id === u).length <= 1) &&
      billingAfter.every((r) => r.user_id !== orphan),
    `rows=${billingAfter.map((r) => `${r.user_id.slice(0, 8)}:${tagOf(r)}`).join(",")}`,
  );

  const verifications = p.events.reduce((n, e) => n + e.copies * e.subjects.length, 0);
  const report: IterationReport = {
    seed,
    iteration,
    backend: backend.kind,
    outcome: invariants.every((i) => i.holds) ? "HELD" : "BROKEN",
    wallMs,
    requests: rows.length + replay.length,
    plan: { ...p, lanes: undefined } as unknown as Omit<Plan, "lanes">,
    lanes: rows,
    rcCalls: burstRc.map((c) => ({
      ...c,
      verdict: c.verdict ? `${c.verdict.kind}:${c.verdict.tag}` : "pending",
    })),
    replay,
    billingFinal: billingAfter,
    auditFinal: auditAfter.map((r) => ({
      id: r.id,
      event_type: r.event_type,
      app_user_id: r.app_user_id,
    })),
    observations: {
      copiesInBurst: rows.length,
      subjectVerificationsRequested: verifications,
      revenueCatCallsDuringBurst: burstRc.length,
      staleWinners,
      ambiguousFreshest,
      flipPattern: p.flipPattern,
      outagePattern: p.outagePattern,
    },
    invariants,
    replayCommand: `STRESS_SEED=${seed} STRESS_ITER=1 STRESS_LATENCY_MS=${STRESS_LATENCY_MS}${backend.kind === "postgres" ? " STRESS_PG_URL=<./xc_pg_up.sh>" : ""} deno test -A --no-check --config deno.json ${file} --filter "${backend.kind}"`,
  };
  return report;
}

function histogram(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
const histogramText = (values: string[]) => JSON.stringify(histogram(values));

async function campaign(backend: Backend, file: string): Promise<void> {
  const reports: IterationReport[] = [];
  const t0 = performance.now();
  const muted = muteRouteConsole();
  try {
    for (let i = 0; i < STRESS_ITER; i++) {
      reports.push(await runIteration(backend, STRESS_SEED + i, i, file));
    }
  } finally {
    muted.restore();
    await backend.close();
  }
  const broken = reports.filter((r) => r.outcome === "BROKEN");
  const brokenNames = histogram(
    broken.flatMap((r) => r.invariants.filter((i) => !i.holds).map((i) => i.name)),
  );
  const summary = {
    backend: backend.kind,
    baseSeed: STRESS_SEED,
    iterations: reports.length,
    requestsExecuted: reports.reduce((n, r) => n + r.requests, 0),
    revenueCatCalls: reports.reduce((n, r) => n + r.rcCalls.length, 0),
    latencyMs: STRESS_LATENCY_MS,
    wallMs: Math.round(performance.now() - t0),
    maxIterationWallMs: Math.max(0, ...reports.map((r) => r.wallMs)),
    held: reports.length - broken.length,
    broken: broken.length,
    brokenInvariants: brokenNames,
    failingSeeds: broken.map((r) => ({
      seed: r.seed,
      iteration: r.iteration,
      invariants: r.invariants.filter((i) => !i.holds).map((i) => `${i.name} — ${i.detail}`),
      replay: r.replayCommand,
    })),
    staleWinnerIterations: reports.filter(
      (r) => (r.observations.staleWinners as unknown[]).length > 0,
    ).length,
    flipPatterns: histogram(reports.map((r) => r.plan.flipPattern)),
    outagePatterns: histogram(reports.map((r) => r.plan.outagePattern)),
    statusHistogram: histogram(reports.flatMap((r) => r.lanes.map((l) => `${l.kind}:${l.status}`))),
    routeLogLines: muted.logs,
    routeErrorLines: muted.errors,
  };
  const dir = `${backend.kind}/`;
  const summaryPath = await writeJson(`${dir}summary.json`, summary);
  const iterationsPath = await writeJson(`${dir}iterations.json`, reports);
  console.log(
    `[stress webhook ${backend.kind}] ${summary.iterations} iterations, ${summary.requestsExecuted} requests, ${summary.wallMs}ms → ${summaryPath}, ${iterationsPath}`,
  );
  for (const [name, n] of Object.entries(brokenNames))
    console.log(`[stress webhook ${backend.kind}]   BROKEN ×${n}: ${name}`);
  for (const r of broken) {
    console.log(
      `[stress webhook ${backend.kind}]   seed ${r.seed}: ${r.invariants
        .filter((i) => !i.holds)
        .map((i) => `${i.name} — ${i.detail}`)
        .join(" | ")}`,
    );
  }
  assertEquals(
    broken.map((r) => r.seed),
    [],
    `${broken.length}/${reports.length} iterations BROKEN — see ${summaryPath}`,
  );
}

const FILE = "stress_webhook_revenuecat_concurrency.test.ts";

Deno.test(
  `stress webhook concurrency [memory]: ${STRESS_ITER} seeded bursts from ${STRESS_SEED} — idempotent audit, one billing row, freshest verdict wins, bounded time`,
  async () => {
    await campaign(new MemoryBackend(), FILE);
  },
);

Deno.test({
  name: `stress webhook concurrency [postgres]: ${STRESS_ITER} seeded bursts from ${STRESS_SEED} against postgres:16 + every migration (STRESS_PG_URL)`,
  ignore: PG_URL === "",
  async fn() {
    await campaign(new PostgresBackend(PG_URL, 24), FILE);
  },
});

// ── Deliberate interleaving: stale verdict persisted LAST ─────────────────────────────
//
// The seeded campaign draws latencies at random; this probe pins the ONE
// interleaving that matters for a lost update and asks whether the route
// defends against it: two deliveries for the same subscriber (e.g. RENEWAL
// and the REFUND/EXPIRATION that follows it, or a webhook racing the app's
// POST /v1/billing/sync — same persistBillingVerdict) both verify; RevenueCat
// answers the OLDER truth to the first and the NEWER truth to the second; the
// second persists first, the first persists last. billing_entitlements must
// end on the newer truth.

interface ProbeCase {
  name: string;
  older: Verdict;
  newer: Verdict;
  /** what the user experiences if the older verdict wins */
  consequence: string;
}

async function stalePersistProbe(backend: Backend, c: ProbeCase, seed: number) {
  const { handler, world } = await loadStressHarness(backend);
  const prng = new Prng(seed);
  const user = prng.uuid();
  const first = `stress-probe-${seed}-first-${prng.uuid().slice(0, 8)}`;
  const second = `stress-probe-${seed}-second-${prng.uuid().slice(0, 8)}`;
  await backend.reset([user], [], [first, second]);
  world.resetRecording();
  world.truth = new Map([[user, [c.older, c.newer]]]);
  const olderTag = c.older.kind === "premium" ? c.older.tag : "free";
  // RevenueCat answers in arrival order; ONLY the older verdict's persist is
  // slow (a PostgREST hop that takes 30 ms instead of ~0 — ordinary jitter).
  world.latency = (hop) => (hop.hop === "billing" && hop.tag === olderTag ? 30 : 0);
  const ip = `10.254.${seed & 255}.${(seed >> 8) & 255}`;
  const muted = muteRouteConsole();
  const [r1, r2] = await Promise.all([
    handler(webhookRequest({ id: first, type: "RENEWAL", app_user_id: user }, { ip })),
    (async () => {
      await sleep(2); // arrives while the first is in flight
      return handler(webhookRequest({ id: second, type: "EXPIRATION", app_user_id: user }, { ip }));
    })(),
  ]);
  muted.restore();
  const b1 = await readJson(r1);
  const b2 = await readJson(r2);
  const rows = await backend.billingFor([user]);
  const audit = await backend.eventsFor([first, second]);
  const newerTag = c.newer.kind === "premium" ? c.newer.tag : "free";
  const rowTag = rows[0] ? tagOf(rows[0]) : "(no row)";
  return {
    name: c.name,
    seed,
    backend: backend.kind,
    statuses: [r1.status, r2.status],
    bodies: [b1, b2],
    rcAnswers: world.rcCalls.map((x) => `${x.verdict?.tag}@${x.tDelivered}`),
    billingWrites: world.billingWrites.map(
      (w) => `${w.premium ? w.product_key : "free"}@${w.verified_at}`,
    ),
    auditRows: audit.length,
    finalRow: rows[0] ?? null,
    finalTag: rowTag,
    newerTag,
    olderTag,
    holds:
      rows.length === 1 &&
      rowTag === newerTag &&
      audit.length === 2 &&
      r1.status === 200 &&
      r2.status === 200,
    consequenceIfStale: c.consequence,
  };
}

const PROBE_CASES: ProbeCase[] = [
  {
    name: "refund/expiration after renewal: premium(older) vs free(newer)",
    older: premium("probe-monthly", new Date(Date.now() + 30 * DAY).toISOString()),
    newer: free(),
    consequence: "lapsed/refunded subscriber keeps premium until the next sync or webhook",
  },
  {
    name: "purchase after free: free(older) vs premium(newer)",
    older: free(),
    newer: premium("probe-monthly", new Date(Date.now() + 30 * DAY).toISOString()),
    consequence: "paying subscriber shows free until the next sync or webhook",
  },
  {
    name: "renewal extends expiry: premium exp+1d(older) vs premium exp+31d(newer)",
    older: premium("probe-monthly", new Date(Date.now() + DAY).toISOString()),
    newer: premium("probe-monthly-renewed", new Date(Date.now() + 31 * DAY).toISOString()),
    consequence:
      "renewed subscriber loses premium at the OLD expiry until the next sync or webhook",
  },
];

Deno.test(
  "stress webhook concurrency [memory]: PROBE — older RevenueCat verdict persisted after the newer one must not win",
  async () => {
    const backend = new MemoryBackend();
    const results = [];
    for (const [i, c] of PROBE_CASES.entries())
      results.push(await stalePersistProbe(backend, c, (STRESS_SEED ^ 0x9b0be) + i));
    const path = await writeJson("memory/stale_persist_probe.json", results);
    for (const r of results)
      console.log(
        `[stress webhook memory] probe ${r.holds ? "HOLDS " : "BROKEN"} ${r.name}: row=${r.finalTag} newer=${r.newerTag} rc=${r.rcAnswers.join(",")} writes=${r.billingWrites.join(",")} → ${path}`,
      );
    assertEquals(
      results.filter((r) => !r.holds).map((r) => r.name),
      [],
      `stale verdict won — see ${path}`,
    );
  },
);

Deno.test({
  name: "stress webhook concurrency [postgres]: PROBE — older RevenueCat verdict persisted after the newer one must not win (STRESS_PG_URL)",
  ignore: PG_URL === "",
  async fn() {
    const backend = new PostgresBackend(PG_URL, 4);
    const results = [];
    try {
      for (const [i, c] of PROBE_CASES.entries())
        results.push(await stalePersistProbe(backend, c, (STRESS_SEED ^ 0x9b0be) + i));
    } finally {
      await backend.close();
    }
    const path = await writeJson("postgres/stale_persist_probe.json", results);
    for (const r of results)
      console.log(
        `[stress webhook postgres] probe ${r.holds ? "HOLDS " : "BROKEN"} ${r.name}: row=${r.finalTag} newer=${r.newerTag} → ${path}`,
      );
    assertEquals(
      results.filter((r) => !r.holds).map((r) => r.name),
      [],
      `stale verdict won — see ${path}`,
    );
  },
});

// ── Single-source flood: the per-IP webhook budget vs. duplicate delivery ────
//
// RevenueCat delivers from a small set of source addresses; WEBHOOK_LIMIT is
// 240/min per IP. 300 concurrent copies of ONE event from ONE address must
// leave exactly one audit row and one billing row, and every copy must be
// either acknowledged (200) or told to retry (429) — never anything else.

Deno.test(
  "stress webhook concurrency [memory]: 300 copies of one event from one IP — ≤240 processed, remainder 429, one audit row, one billing row",
  async () => {
    const backend = new MemoryBackend();
    const { handler, world } = await loadStressHarness(backend);
    const prng = new Prng(STRESS_SEED ^ 0x5f10d);
    const user = prng.uuid();
    const eventId = `stress-flood-${prng.uuid().slice(0, 8)}`;
    await backend.reset([user], [], [eventId]);
    world.resetRecording();
    world.truth = new Map([
      [user, [premium("flood-monthly", new Date(Date.now() + 30 * DAY).toISOString())]],
    ]);
    world.latency = seededLatency(prng, STRESS_LATENCY_MS);
    const ip = "10.255.255.1";
    const t0 = performance.now();
    const muted = muteRouteConsole();
    const statuses = await Promise.all(
      Array.from({ length: 300 }, async (_, i) => {
        await sleep(prng.int(0, STRESS_LATENCY_MS));
        const response = await handler(
          webhookRequest({ id: eventId, type: "INITIAL_PURCHASE", app_user_id: user }, { ip }),
        );
        const body = await readJson(response);
        return { i, status: response.status, duplicate: body.duplicate === true };
      }),
    );
    muted.restore();
    const wallMs = Math.round(performance.now() - t0);
    const hist = histogram(statuses.map((s) => String(s.status)));
    const audit = await backend.eventsFor([eventId]);
    const billing = await backend.billingFor([user]);
    const report = {
      seed: STRESS_SEED ^ 0x5f10d,
      copies: 300,
      wallMs,
      statusHistogram: hist,
      duplicatesShortCircuited: statuses.filter((s) => s.duplicate).length,
      revenueCatCalls: world.rcCalls.length,
      auditRows: audit.length,
      billingRows: billing.length,
    };
    const path = await writeJson("memory/flood_single_ip.json", report);
    console.log(
      `[stress webhook memory] flood: ${JSON.stringify(hist)} rc=${world.rcCalls.length} → ${path}`,
    );
    assert(
      statuses.every((s) => s.status === 200 || s.status === 429),
      JSON.stringify(hist),
    );
    assertEquals(hist["200"], 240, "exactly the per-IP budget is processed");
    assertEquals(audit.length, 1);
    assertEquals(billing.length, 1);
    assertEquals(billing[0].product_key, "flood-monthly");
    assert(wallMs < STRESS_BURST_TIMEOUT_MS, `bounded: ${wallMs}ms`);
  },
);
