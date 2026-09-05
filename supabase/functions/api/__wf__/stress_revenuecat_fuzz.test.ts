/**
 * STRESS / fuzz-boundary — POST /webhooks/revenuecat (the REAL handler in
 * index.ts, driven in-process through routesHarness with RevenueCat and
 * PostgREST modelled by the stateful fake in stress_revenuecat_fuzz_lib.ts;
 * Upstash is unset, so the production in-memory rate-limit fallback is what
 * runs).
 *
 * Every iteration derives its own 32-bit seed from the campaign seed and is
 * replayable on its own:
 *
 *   # fast default (lives in `deno task test`)
 *   deno test -A --no-check --config deno.json stress_revenuecat_fuzz.test.ts
 *
 *   # full campaign + JSON evidence table
 *   STRESS_ITER=3000 STRESS_SEED=20260905 STRESS_OUT_DIR=/tmp/stress-rc \
 *     deno test -A --no-check --config deno.json stress_revenuecat_fuzz.test.ts
 *
 *   # replay ONE iteration from the seed printed in the table
 *   STRESS_REPLAY_SEED=<iterationSeed> STRESS_OUT_DIR=/tmp/stress-rc \
 *     deno test -A --no-check --config deno.json stress_revenuecat_fuzz.test.ts
 *
 * Hard invariants (the campaign test FAILS when any is violated):
 *   I1  every response carries x-request-id (echoing a valid incoming id)
 *   I2  a rejected request answers only 400/401/403/404/405/413/415/429
 *   I3  a 5xx is 500/503 with one of the generic messages, JSON, no leak tokens
 *   I4  no body ever contains a stack frame / internal identifier
 *   I5  a rejected request (4xx/5xx) performs NO PostgREST write
 *   I6  an unauthenticated (401) or event-less (400) request performs no
 *       outbound call at all (no RevenueCat, no PostgREST)
 *   I7  the stored billing_entitlements row equals RevenueCat's verdict for
 *       the queried app_user_id — never anything the event body claims
 *   I8  a replayed event id is acknowledged as duplicate with zero RevenueCat
 *       calls and zero writes; exactly one audit row exists per event id
 *   I9  a status outside {200} ∪ I2 ∪ {500,503} never happens
 *
 * Observations that are NOT hard failures (recorded per seed in the JSON table
 * and pinned by the `REPRO (defect)` tests at the bottom, repo convention):
 *   O1  audit row silently lost on a 200 (payload/id Postgres refuses, or a
 *       PostgREST write failure) → replay dedupe cannot work for that event
 *   O2  upper-cased uuid alias of a premium user is verified as a DIFFERENT
 *       RevenueCat subscriber (auto-created, free) and its verdict overwrites
 *       the real user's billing_entitlements row (uuid compares case-insensitively)
 *   O3  a TRANSFER-style event fans out to one RevenueCat call + one billing
 *       write PER uuid in transferred_from/transferred_to with no cap
 */

import { assert, assertEquals } from "@std/assert";
import { loadHarness, WEBHOOK_SECRET } from "./routesHarness.ts";
import {
  errorMessageOf,
  expectedSubjects,
  type FakeBackends,
  type FaultPlan,
  generateAuth,
  generateBody,
  generateFaults,
  generateHeaders,
  generateRoute,
  GENERIC_5XX_MESSAGES,
  headerSafe,
  hostileString,
  installFakeBackends,
  inspect,
  type Inspected,
  iterationSeed,
  MAX_JSON_BODY_BYTES,
  NO_FAULTS,
  pgIndexRowTooLarge,
  pgRejectsJson,
  Prng,
  REJECT_STATUSES,
  REQUEST_ID_RE,
} from "./stress_revenuecat_fuzz_lib.ts";

const CAMPAIGN_SEED = Number(Deno.env.get("STRESS_SEED") ?? "20260905") >>> 0;
const ITERATIONS = Math.max(1, Number(Deno.env.get("STRESS_ITER") ?? "300") | 0);
const REPLAY_SEED = Deno.env.get("STRESS_REPLAY_SEED");
const OUT_DIR = Deno.env.get("STRESS_OUT_DIR") ?? "";
const WEBHOOK_URL = "http://edge.test/functions/v1/api/webhooks/revenuecat";

const utf8Len = (s: string | Uint8Array): number =>
  typeof s === "string" ? new TextEncoder().encode(s).byteLength : s.byteLength;

/** Distinct client IP per iteration so the per-IP webhook budget (240/min)
 * only trips in the dedicated rate-limit scenario. */
const ipFor = (seed: number): string =>
  `10.${(seed >>> 16) & 0xff}.${(seed >>> 8) & 0xff}.${seed & 0xff}`;

interface Row {
  i: number;
  seed: number;
  scenario: string;
  requests: number;
  route: string;
  auth: string;
  headers: string;
  body: string;
  bodyBytes: number;
  faults: FaultPlan | null;
  statuses: number[];
  rcCalls: number;
  writes: number;
  pgErrors: string[];
  violations: string[];
  observations: string[];
  fiveXX: Array<{ status: number; body: string; requestHeaders: Record<string, string>; payloadPreview: string }>;
  ms: number;
}

interface Campaign {
  rows: Row[];
  requests: number;
  violations: number;
  fiveXX: number;
}

function replayCommand(seed: number): string {
  return `STRESS_REPLAY_SEED=${seed} deno test -A --no-check --config deno.json stress_revenuecat_fuzz.test.ts`;
}

function buildRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | Uint8Array | null,
): Request {
  const safe = new Headers();
  for (const [k, v] of Object.entries(headers)) safe.set(k, headerSafe(v));
  const noBody = /^(GET|HEAD)$/i.test(method) || body === null;
  return new Request(url, { method, headers: safe, body: noBody ? undefined : body });
}

/** The request id the outer handler must answer with: the incoming header
 * (as the Request actually carries it — Headers trims surrounding whitespace)
 * when it matches the accepted shape, otherwise a fresh id that differs. */
function expectedRequestId(request: Request): string | null {
  const incoming = request.headers.get("x-request-id")?.trim() ?? "";
  return REQUEST_ID_RE.test(incoming) ? incoming : null;
}

/** Universal per-response checks (I1, I3, I4, I9). */
function checkResponse(
  res: Inspected,
  request: Request,
  violations: string[],
): void {
  const expectId = expectedRequestId(request);
  const sentId = request.headers.get("x-request-id");
  if (!res.requestId) violations.push(`I1 missing x-request-id (status ${res.status})`);
  else if (!REQUEST_ID_RE.test(res.requestId)) {
    violations.push(`I1 x-request-id not in [A-Za-z0-9._-]{8,64}: ${JSON.stringify(res.requestId)}`);
  } else if (expectId !== null && res.requestId !== expectId) {
    violations.push(`I1 valid incoming request id not echoed: sent ${JSON.stringify(expectId)} got ${res.requestId}`);
  } else if (expectId === null && sentId !== null && res.requestId === sentId.trim()) {
    violations.push(`I1 INVALID incoming request id was echoed: ${JSON.stringify(sentId)}`);
  }
  if (res.leaks.length) violations.push(`I4 leak tokens in body: ${res.leaks.join(",")}`);
  if (res.status >= 500) {
    if (res.status !== 500 && res.status !== 503) violations.push(`I3 unexpected 5xx status ${res.status}`);
    const message = errorMessageOf(res.json);
    if (!message || !GENERIC_5XX_MESSAGES.has(message)) {
      violations.push(`I3 non-generic 5xx body: ${res.text.slice(0, 200)}`);
    }
    if (!(res.contentType ?? "").includes("application/json")) violations.push(`I3 5xx not JSON: ${res.contentType}`);
  } else if (res.status >= 400) {
    if (!REJECT_STATUSES.has(res.status)) violations.push(`I2 reject status ${res.status} not in allowed set`);
    if (!(res.contentType ?? "").includes("application/json")) violations.push(`I2 4xx not JSON: ${res.contentType}`);
  } else if (res.status !== 200) {
    violations.push(`I9 unexpected status ${res.status}`);
  }
}

const previewOf = (body: string | Uint8Array | null): string => {
  if (body === null) return "";
  const text = typeof body === "string" ? body : `<${body.byteLength} binary bytes>`;
  return text.length > 4096 ? `${text.slice(0, 4096)}…(+${text.length - 4096} chars)` : text;
};

// ─────────────────────────────────────────────────────────────────────────────
// Scenario: one generated request
// ─────────────────────────────────────────────────────────────────────────────

async function scenarioSingle(
  h: Awaited<ReturnType<typeof loadHarness>>,
  fake: FakeBackends,
  prng: Prng,
  row: Row,
): Promise<void> {
  const userId = prng.uuid();
  const truthPremium = prng.chance(0.5);
  const hasProfile = prng.chance(0.85);
  if (hasProfile) fake.profiles.add(userId);
  fake.rcTruth.set(userId, {
    premium: truthPremium,
    expiresAt: prng.chance(0.3) ? null : new Date(Date.now() + 86_400_000).toISOString(),
    product: "pickle_sensei_pro_monthly",
  });

  const route = generateRoute(prng);
  const auth = generateAuth(prng, WEBHOOK_SECRET);
  const headerPlan = generateHeaders(prng, ipFor(prng.seed));
  const body = generateBody(prng, userId);
  const faults = generateFaults(prng);
  fake.faults = faults;

  const headers = { ...headerPlan.headers };
  if (auth.header !== null) headers["authorization"] = auth.header;
  const request = buildRequest(route.method, `http://edge.test${route.path}${route.query}`, headers, body.raw);

  row.route = `${route.method} ${route.path}${route.query.slice(0, 80)} [${route.note}]`;
  row.auth = auth.note;
  row.headers = headerPlan.note;
  row.body = `${body.kind}:${body.note}`;
  row.bodyBytes = utf8Len(body.raw);
  row.faults = faults;
  row.requests = 1;

  const declared = Number(request.headers.get("content-length") ?? "0");
  const declaredTooLarge = Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES;
  const sentAuth = request.headers.get("authorization") ?? "";
  const authValid = sentAuth === WEBHOOK_SECRET;
  // Hostile ids repeat across iterations ("", "null", "__proto__", …); the fake
  // store persists for the campaign, so such an event is legitimately a replay.
  const preExistingId = body.event && typeof body.event.id === "string" && fake.webhookEvents.has(body.event.id);

  const response = await h.handler(request);
  const res = await inspect(response);
  row.statuses.push(res.status);
  const c = fake.counters;
  row.rcCalls = c.rcCalls;
  row.writes = c.writes;
  row.pgErrors = c.pgErrors;
  const v = row.violations;
  checkResponse(res, request, v);
  if (res.status >= 500) {
    row.fiveXX.push({ status: res.status, body: res.text.slice(0, 2000), requestHeaders: headers, payloadPreview: previewOf(body.raw) });
  }

  if (!route.reachesWebhook) {
    // Falls through to the authenticated router: must be a clean reject and
    // must never write (the webhook secret is not a bearer token).
    if (res.status < 400) v.push(`I2 non-webhook ${route.method} ${route.path} answered ${res.status}`);
    if (c.writes > 0) v.push(`I5 write on non-webhook route (${c.writes})`);
    if (c.rcCalls > 0) v.push(`I6 RevenueCat called on non-webhook route`);
    return;
  }
  if (!authValid) {
    if (res.status !== 401) v.push(`I2 bad auth (${auth.note}) → ${res.status}, expected 401`);
    if (c.writes + c.rcCalls + c.lookups > 0) v.push(`I6 outbound call on 401 (rc=${c.rcCalls} lookups=${c.lookups} writes=${c.writes})`);
    return;
  }
  if (declaredTooLarge || row.bodyBytes > MAX_JSON_BODY_BYTES) {
    if (res.status !== 413) v.push(`I2 oversized (declared ${declared}, actual ${row.bodyBytes}) → ${res.status}, expected 413`);
    if (c.writes + c.rcCalls + c.lookups > 0) v.push(`I6 outbound call on 413`);
    return;
  }
  if (!body.event) {
    if (res.status !== 400) v.push(`I2 event-less body (${body.kind}) → ${res.status}, expected 400`);
    if (c.writes + c.rcCalls + c.lookups > 0) v.push(`I6 outbound call on 400 (rc=${c.rcCalls} lookups=${c.lookups} writes=${c.writes})`);
    return;
  }

  if (preExistingId && !faults.lookupFail) {
    if (res.status !== 200 || res.json?.duplicate !== true) v.push(`I8 replayed id → ${res.status} ${res.text.slice(0, 100)}`);
    if (c.rcCalls + c.writes > 0) v.push(`I8 replayed id did work (rc=${c.rcCalls} writes=${c.writes})`);
    row.body += "+replayed-id";
    return;
  }

  // Accepted by the gate: model the handler's subject derivation + faults.
  const event = body.event;
  const subjects = expectedSubjects(event);
  const eventId = typeof event.id === "string" ? event.id : null;
  const eventRowRejected = pgRejectsJson({ id: eventId ?? "uuid", event_type: typeof event.type === "string" ? event.type : "unknown", app_user_id: subjects.rcIds[0] ?? null, payload: body.parsed });
  const eventIdTooLong = eventId !== null && pgIndexRowTooLarge(eventId);
  const auditWritable = !faults.logFail && !eventRowRejected && !eventIdTooLong;

  if (subjects.rcIds.length === 0) {
    if (res.status !== 200) v.push(`I9 no-subject event → ${res.status}, expected 200`);
    else if (res.json?.received !== true || res.json?.verified !== false) v.push(`I9 no-subject body ${res.text.slice(0, 100)}`);
    if (c.rcCalls > 0) v.push(`I7 RevenueCat called without a uuid subject (${c.rcIds.join(",")})`);
    if (c.billingUpserts > 0) v.push(`I7 billing write without a uuid subject`);
    if (eventId !== null && res.status === 200) {
      const stored = fake.webhookEvents.has(eventId);
      if (auditWritable && !stored) v.push(`I8 audit row missing although writable`);
      if (!auditWritable && !stored) row.observations.push(`O1 audit row lost on 200 (${c.pgErrors.join(",") || "no-pg-error"})`);
    }
    return;
  }

  const rcFailsAt = faults.rc === "ok" ? -1 : Math.max(0, faults.rcFailAfter);
  const rcFails = rcFailsAt >= 0 && rcFailsAt < subjects.rcIds.length;
  if (rcFails) {
    if (res.status !== 503) v.push(`I3 RevenueCat ${faults.rc} → ${res.status}, expected 503`);
    if (errorMessageOf(res.json) !== "Verification is temporarily unavailable.") v.push(`I3 503 message ${res.text.slice(0, 120)}`);
    if (c.writes > 0) v.push(`I5 write on 503 (${c.writes})`);
    if (c.rcCalls !== rcFailsAt + 1) v.push(`I7 rc calls ${c.rcCalls} ≠ ${rcFailsAt + 1} before failure`);
    return;
  }

  if (res.status !== 200) {
    v.push(`I9 verified event → ${res.status}, expected 200 (${res.text.slice(0, 120)})`);
    return;
  }
  if (c.rcCalls !== subjects.rcIds.length) v.push(`I7 rc calls ${c.rcCalls} ≠ subjects ${subjects.rcIds.length}`);
  for (let k = 0; k < subjects.rcIds.length; k++) {
    if (c.rcIds[k] !== subjects.rcIds[k]) v.push(`I7 rc subject[${k}] ${c.rcIds[k]} ≠ ${subjects.rcIds[k]}`);
  }
  // Expected billing state: verdict of each RC id, applied in order, keyed by
  // the case-insensitive uuid (Postgres uuid semantics).
  const expectedBilling = new Map<string, boolean>();
  for (const rcId of subjects.rcIds) expectedBilling.set(rcId.toLowerCase(), fake.rcTruth.get(rcId)?.premium ?? false);
  let anyBillingError = false;
  for (const [key, premium] of expectedBilling) {
    const stored = fake.billing.get(key);
    const writable = fake.profiles.has(key) && !faults.billingFail;
    if (!writable) {
      anyBillingError = true;
      if (stored) v.push(`I7 billing row written despite FK/backend failure for ${key}`);
      continue;
    }
    if (!stored) {
      v.push(`I7 billing row missing for ${key}`);
      continue;
    }
    if (stored.premium !== premium) v.push(`I7 billing.premium=${stored.premium} but RevenueCat truth=${premium} for ${key}`);
    const truthLower = fake.rcTruth.get(key);
    if (truthLower?.premium && !premium) {
      row.observations.push(`O2 case-alias revocation: ${key} premium→false via RC id ${subjects.rcIds.find((id) => id.toLowerCase() === key && id !== key)}`);
    }
  }
  if (c.billingUpserts !== expectedBilling.size && c.billingUpserts !== subjects.rcIds.length) {
    v.push(`I7 billing upserts ${c.billingUpserts} ≠ ${subjects.rcIds.length}`);
  }
  if (res.json?.verified !== !anyBillingError) v.push(`I9 verified=${res.json?.verified} expected ${!anyBillingError}`);
  if (eventId !== null) {
    const stored = fake.webhookEvents.has(eventId);
    if (auditWritable && !stored) v.push(`I8 audit row missing although writable`);
    if (!auditWritable && !stored) row.observations.push(`O1 audit row lost on 200 (${c.pgErrors.join(",") || "no-pg-error"})`);
  }
  if (subjects.rcIds.length >= 8) row.observations.push(`O3 fan-out ${subjects.rcIds.length} RevenueCat calls from one event`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario: sequential replay of one event id (I8), body allowed to mutate
// ─────────────────────────────────────────────────────────────────────────────

async function scenarioReplay(
  h: Awaited<ReturnType<typeof loadHarness>>,
  fake: FakeBackends,
  prng: Prng,
  row: Row,
): Promise<void> {
  const userId = prng.uuid();
  fake.profiles.add(userId);
  const truthPremium = prng.chance(0.5);
  fake.rcTruth.set(userId, { premium: truthPremium, expiresAt: null, product: "pickle_sensei_pro_lifetime" });
  fake.faults = { ...NO_FAULTS };
  // Suffix keeps ids unique across iterations (the fake store persists for the
  // whole campaign and a repeated id is legitimately a duplicate).
  const eventId = prng.chance(0.8) ? prng.hex(32).toUpperCase() : `${hostileString(prng).slice(0, 2000)}#${prng.hex(8)}`;
  const replays = prng.int(1, 6);
  const headerPlan = generateHeaders(prng, ipFor(prng.seed));
  delete headerPlan.headers["content-length"];
  row.route = "POST canonical (replay)";
  row.auth = "valid";
  row.headers = headerPlan.note;
  row.body = `replay id=${JSON.stringify(eventId).slice(0, 60)} x${replays + 1}`;
  row.faults = fake.faults;
  const auditWritable = !pgRejectsJson({ id: eventId }) && !pgIndexRowTooLarge(eventId);

  for (let n = 0; n <= replays; n++) {
    fake.resetCounters();
    // Replays may LIE differently each time — none of it may matter.
    const event: Record<string, unknown> = {
      id: eventId,
      type: n === 0 ? "INITIAL_PURCHASE" : prng.pick(["EXPIRATION", "CANCELLATION", "RENEWAL", "TRANSFER", hostileString(prng)]),
      app_user_id: userId,
      entitlement_ids: ["pickle_sensei_pro"],
      premium: !truthPremium,
      nonce: prng.hex(8),
    };
    const raw = JSON.stringify({ api_version: "1.0", event });
    row.bodyBytes += utf8Len(raw);
    const headers = { ...headerPlan.headers, authorization: WEBHOOK_SECRET };
    const request = buildRequest("POST", WEBHOOK_URL, headers, raw);
    const res = await inspect(await h.handler(request));
    row.requests += 1;
    row.statuses.push(res.status);
    checkResponse(res, request, row.violations);
    const c = fake.counters;
    row.rcCalls += c.rcCalls;
    row.writes += c.writes;
    row.pgErrors.push(...c.pgErrors);
    if (res.status !== 200) {
      row.violations.push(`I8 replay #${n} → ${res.status}`);
      if (res.status >= 500) row.fiveXX.push({ status: res.status, body: res.text, requestHeaders: headers, payloadPreview: raw.slice(0, 4096) });
      continue;
    }
    if (n === 0) {
      if (c.rcCalls !== 1 || res.json?.verified !== true) row.violations.push(`I8 first delivery rc=${c.rcCalls} body=${res.text}`);
    } else if (auditWritable) {
      if (res.json?.duplicate !== true) row.violations.push(`I8 replay #${n} not flagged duplicate: ${res.text}`);
      if (c.rcCalls !== 0) row.violations.push(`I8 replay #${n} re-verified with RevenueCat (${c.rcCalls} calls)`);
      if (c.writes !== 0) row.violations.push(`I8 replay #${n} wrote (${c.writes})`);
    } else {
      // Audit row could never be stored → the handler cannot dedupe; record.
      if (c.rcCalls !== 1) row.violations.push(`I8 unlogged replay #${n} rc=${c.rcCalls}`);
      if (n === 1) row.observations.push(`O1 audit row lost on 200 → replay re-verified every time (${c.pgErrors.join(",")})`);
    }
  }
  const stored = fake.billing.get(userId);
  if (!stored || stored.premium !== truthPremium) row.violations.push(`I7 final billing ${JSON.stringify(stored)} ≠ truth ${truthPremium}`);
  const auditRows = [...fake.webhookEvents.values()].filter((r) => r.id === eventId).length;
  if (auditWritable && auditRows !== 1) row.violations.push(`I8 audit rows for id = ${auditRows}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario: concurrent duplicate burst (I7/I8 under a race)
// ─────────────────────────────────────────────────────────────────────────────

async function scenarioBurst(
  h: Awaited<ReturnType<typeof loadHarness>>,
  fake: FakeBackends,
  prng: Prng,
  row: Row,
): Promise<void> {
  const userId = prng.uuid();
  fake.profiles.add(userId);
  const truthPremium = prng.chance(0.5);
  fake.rcTruth.set(userId, { premium: truthPremium, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), product: "pickle_sensei_pro_monthly" });
  fake.faults = { ...NO_FAULTS };
  const eventId = `burst-${prng.hex(24)}`;
  const n = prng.int(2, 12);
  row.route = "POST canonical (burst)";
  row.auth = "valid";
  row.headers = "plain";
  row.body = `burst x${n} id=${eventId}`;
  row.faults = fake.faults;
  const raws = Array.from({ length: n }, (_, k) =>
    JSON.stringify({
      api_version: "1.0",
      event: { id: eventId, type: truthPremium ? "EXPIRATION" : "INITIAL_PURCHASE", app_user_id: userId, copy: k },
    }),
  );
  const requests = raws.map((raw) =>
    buildRequest("POST", WEBHOOK_URL, { "x-forwarded-for": ipFor(prng.seed), "content-type": "application/json", authorization: WEBHOOK_SECRET }, raw),
  );
  const responses = await Promise.all(requests.map((request) => h.handler(request)));
  for (let k = 0; k < responses.length; k++) {
    const res = await inspect(responses[k]);
    row.requests += 1;
    row.statuses.push(res.status);
    checkResponse(res, requests[k], row.violations);
    if (res.status !== 200) row.violations.push(`I8 burst copy → ${res.status} ${res.text.slice(0, 100)}`);
  }
  const c = fake.counters;
  row.rcCalls = c.rcCalls;
  row.writes = c.writes;
  row.pgErrors = c.pgErrors;
  if (c.rcCalls < 1 || c.rcCalls > n) row.violations.push(`I8 burst rc calls ${c.rcCalls} outside [1,${n}]`);
  const auditRows = [...fake.webhookEvents.values()].filter((r) => r.id === eventId).length;
  if (auditRows !== 1) row.violations.push(`I8 burst audit rows ${auditRows} ≠ 1`);
  const stored = fake.billing.get(userId);
  if (!stored || stored.premium !== truthPremium) row.violations.push(`I7 burst billing ${JSON.stringify(stored)} ≠ truth ${truthPremium}`);
  // A later replay must short-circuit.
  fake.resetCounters();
  const replay = await inspect(await h.handler(buildRequest("POST", WEBHOOK_URL, { "x-forwarded-for": ipFor(prng.seed), "content-type": "application/json", authorization: WEBHOOK_SECRET }, raws[0])));
  row.requests += 1;
  row.statuses.push(replay.status);
  if (replay.json?.duplicate !== true || fake.counters.rcCalls !== 0 || fake.counters.writes !== 0) {
    row.violations.push(`I8 post-burst replay rc=${fake.counters.rcCalls} writes=${fake.counters.writes} body=${replay.text}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario: TRANSFER fan-out (O3) — how many RevenueCat calls does one event buy
// ─────────────────────────────────────────────────────────────────────────────

async function scenarioFanout(
  h: Awaited<ReturnType<typeof loadHarness>>,
  fake: FakeBackends,
  prng: Prng,
  row: Row,
): Promise<void> {
  fake.faults = { ...NO_FAULTS };
  const count = prng.int(50, 400);
  const ids = Array.from({ length: count }, () => prng.uuid());
  for (const id of ids) fake.profiles.add(id);
  const raw = JSON.stringify({
    api_version: "1.0",
    event: { id: `fanout-${prng.hex(16)}`, type: "TRANSFER", transferred_from: ids.slice(0, count >> 1), transferred_to: ids.slice(count >> 1) },
  });
  row.route = "POST canonical (fan-out)";
  row.auth = "valid";
  row.headers = "plain";
  row.body = `TRANSFER with ${count} uuids`;
  row.bodyBytes = utf8Len(raw);
  row.faults = fake.faults;
  const request = buildRequest("POST", WEBHOOK_URL, { "x-forwarded-for": ipFor(prng.seed), "content-type": "application/json", authorization: WEBHOOK_SECRET }, raw);
  const res = await inspect(await h.handler(request));
  row.requests = 1;
  row.statuses.push(res.status);
  checkResponse(res, request, row.violations);
  const c = fake.counters;
  row.rcCalls = c.rcCalls;
  row.writes = c.writes;
  if (res.status !== 200) row.violations.push(`I9 fan-out → ${res.status}`);
  if (c.rcCalls !== count) row.violations.push(`I7 fan-out rc calls ${c.rcCalls} ≠ ${count}`);
  row.observations.push(`O3 fan-out ${c.rcCalls} RevenueCat calls + ${c.billingUpserts} billing writes from one ${row.bodyBytes}-byte event`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign driver
// ─────────────────────────────────────────────────────────────────────────────

async function runIteration(
  h: Awaited<ReturnType<typeof loadHarness>>,
  fake: FakeBackends,
  i: number,
  seed: number,
): Promise<Row> {
  const prng = new Prng(seed);
  const row: Row = {
    i,
    seed,
    scenario: "",
    requests: 0,
    route: "",
    auth: "",
    headers: "",
    body: "",
    bodyBytes: 0,
    faults: null,
    statuses: [],
    rcCalls: 0,
    writes: 0,
    pgErrors: [],
    violations: [],
    observations: [],
    fiveXX: [],
    ms: 0,
  };
  fake.resetCounters();
  fake.faults = { ...NO_FAULTS };
  const started = performance.now();
  const roll = prng.next();
  try {
    if (roll < 0.8) {
      row.scenario = "single";
      await scenarioSingle(h, fake, prng, row);
    } else if (roll < 0.92) {
      row.scenario = "replay";
      await scenarioReplay(h, fake, prng, row);
    } else if (roll < 0.97) {
      row.scenario = "burst";
      await scenarioBurst(h, fake, prng, row);
    } else {
      row.scenario = "fanout";
      await scenarioFanout(h, fake, prng, row);
    }
  } catch (error) {
    row.violations.push(`HARNESS threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  row.ms = Math.round((performance.now() - started) * 10) / 10;
  return row;
}

async function runCampaign(seeds: Array<[number, number]>): Promise<Campaign> {
  const h = await loadHarness();
  const fake = installFakeBackends();
  const rows: Row[] = [];
  try {
    for (const [i, seed] of seeds) rows.push(await runIteration(h, fake, i, seed));
  } finally {
    fake.uninstall();
  }
  return {
    rows,
    requests: rows.reduce((n, r) => n + r.requests, 0),
    violations: rows.filter((r) => r.violations.length).length,
    fiveXX: rows.reduce((n, r) => n + r.fiveXX.length, 0),
  };
}

async function writeArtifacts(name: string, campaign: Campaign, extra: Record<string, unknown>): Promise<string | null> {
  if (!OUT_DIR) return null;
  await Deno.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    campaignSeed: CAMPAIGN_SEED,
    iterations: campaign.rows.length,
    requests: campaign.requests,
    iterationsWithViolations: campaign.violations,
    fiveXXResponses: campaign.fiveXX,
    statusHistogram: campaign.rows.flatMap((r) => r.statuses).reduce<Record<string, number>>((acc, s) => ((acc[s] = (acc[s] ?? 0) + 1), acc), {}),
    scenarioHistogram: campaign.rows.reduce<Record<string, number>>((acc, r) => ((acc[r.scenario] = (acc[r.scenario] ?? 0) + 1), acc), {}),
    observationHistogram: campaign.rows.flatMap((r) => r.observations.map((o) => o.slice(0, 2))).reduce<Record<string, number>>((acc, o) => ((acc[o] = (acc[o] ?? 0) + 1), acc), {}),
    violations: campaign.rows.filter((r) => r.violations.length).map((r) => ({ seed: r.seed, replay: replayCommand(r.seed), violations: r.violations })),
    fiveXX: campaign.rows.filter((r) => r.fiveXX.length).map((r) => ({ seed: r.seed, replay: replayCommand(r.seed), faults: r.faults, fiveXX: r.fiveXX })),
    observations: campaign.rows.filter((r) => r.observations.length).map((r) => ({ seed: r.seed, replay: replayCommand(r.seed), body: r.body, observations: r.observations })),
    ...extra,
  };
  const tablePath = `${OUT_DIR}/${name}.rows.json`;
  const summaryPath = `${OUT_DIR}/${name}.summary.json`;
  await Deno.writeTextFile(tablePath, JSON.stringify(campaign.rows.map((r) => ({ ...r, faults: r.faults, fiveXX: r.fiveXX.length ? r.fiveXX : undefined })), null, 0));
  await Deno.writeTextFile(summaryPath, JSON.stringify(summary, null, 2));
  return summaryPath;
}

Deno.test(
  `stress fuzz-boundary: POST /webhooks/revenuecat — ${REPLAY_SEED ? `replay seed ${REPLAY_SEED}` : `${ITERATIONS} seeded iterations from campaign seed ${CAMPAIGN_SEED}`}`,
  async () => {
    const seeds: Array<[number, number]> = REPLAY_SEED
      ? [[0, Number(REPLAY_SEED) >>> 0]]
      : Array.from({ length: ITERATIONS }, (_, i) => [i, iterationSeed(CAMPAIGN_SEED, i)]);
    const campaign = await runCampaign(seeds);
    const summaryPath = await writeArtifacts("stress_revenuecat_fuzz", campaign, {});
    const failing = campaign.rows.filter((r) => r.violations.length);
    const obs = campaign.rows.flatMap((r) => r.observations);
    console.log(
      `[stress] revenuecat fuzz: iterations=${campaign.rows.length} requests=${campaign.requests} ` +
        `violations=${failing.length} 5xx=${campaign.fiveXX} observations=${obs.length}` +
        (summaryPath ? ` → ${summaryPath}` : ""),
    );
    if (REPLAY_SEED) console.log(JSON.stringify(campaign.rows[0], null, 2));
    for (const r of failing.slice(0, 20)) console.log(`[stress]   seed ${r.seed}: ${r.violations.join(" | ")}  (${replayCommand(r.seed)})`);
    assert(campaign.requests >= seeds.length, "every iteration issued at least one request");
    assertEquals(
      failing.map((r) => `${r.seed}: ${r.violations[0]}`),
      [],
      `${failing.length} iteration(s) violated a hard invariant — replay with STRESS_REPLAY_SEED=<seed>`,
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic boundary scenarios (always run)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress boundary: per-IP webhook budget — 240 accepted, 241st is 429 with Retry-After, request id, no outbound call", async () => {
  const h = await loadHarness();
  const fake = installFakeBackends();
  try {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const ip = `10.99.${attempt}.${(CAMPAIGN_SEED >>> 24) & 0xff}`;
      const bucketBefore = Math.floor(Date.now() / 60_000);
      const statuses: number[] = [];
      let last: Inspected | null = null;
      fake.resetCounters();
      for (let n = 0; n < 241; n++) {
        // Cheap valid-auth requests with no event → 400 until the budget trips.
        last = await inspect(await h.handler(buildRequest("POST", WEBHOOK_URL, { "x-forwarded-for": ip, "content-type": "application/json", authorization: WEBHOOK_SECRET }, "{}")));
        statuses.push(last.status);
        assert(last.requestId && REQUEST_ID_RE.test(last.requestId), "x-request-id on every response");
      }
      const bucketAfter = Math.floor(Date.now() / 60_000);
      if (bucketBefore !== bucketAfter && attempt < 3) continue; // clock-minute boundary crossed: re-run on a fresh IP
      assertEquals(statuses.filter((s) => s === 400).length, 240, "first 240 pass the budget");
      assertEquals(last?.status, 429);
      assert(Number(last?.text && JSON.parse(last.text).error.code === "rate_limited"), "rate_limited code");
      assertEquals(fake.counters.writes + fake.counters.rcCalls + fake.counters.lookups, 0, "no outbound call across 241 rejected requests");
      break;
    }
  } finally {
    fake.uninstall();
  }
});

Deno.test("stress boundary: body size — exactly 5_000_000 bytes is processed, 5_000_001 (declared or streamed without Content-Length) is 413 before any outbound call", async () => {
  const h = await loadHarness();
  const fake = installFakeBackends();
  try {
    const userId = "33333333-3333-4333-8333-333333333333";
    fake.profiles.add(userId);
    fake.rcTruth.set(userId, { premium: true, expiresAt: null, product: "pickle_sensei_pro_lifetime" });
    const skeleton = (pad: number) => {
      const head = `{"api_version":"1.0","event":{"id":"size-${pad}","type":"TEST","app_user_id":"${userId}","pad":"`;
      const tail = `"}}`;
      return head + "a".repeat(pad - head.length - tail.length) + tail;
    };
    const exact = skeleton(MAX_JSON_BODY_BYTES);
    assertEquals(utf8Len(exact), MAX_JSON_BODY_BYTES);
    fake.resetCounters();
    const ok = await inspect(await h.handler(buildRequest("POST", WEBHOOK_URL, { "x-forwarded-for": "10.98.0.1", "content-type": "application/json", authorization: WEBHOOK_SECRET }, exact)));
    assertEquals(ok.status, 200, ok.text);
    assertEquals(fake.counters.rcCalls, 1);

    const over = skeleton(MAX_JSON_BODY_BYTES + 1);
    fake.resetCounters();
    const declared = await inspect(await h.handler(buildRequest("POST", WEBHOOK_URL, { "x-forwarded-for": "10.98.0.2", "content-type": "application/json", authorization: WEBHOOK_SECRET }, over)));
    assertEquals(declared.status, 413, declared.text);
    assert(declared.requestId, "request id on 413");
    assertEquals(fake.counters.rcCalls + fake.counters.writes + fake.counters.lookups, 0);

    // Chunked upload: no Content-Length, cap must trip on counted bytes.
    const bytes = new TextEncoder().encode(over);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let o = 0; o < bytes.length; o += 65_536) controller.enqueue(bytes.slice(o, o + 65_536));
        controller.close();
      },
    });
    const headers = new Headers({ "x-forwarded-for": "10.98.0.3", "content-type": "application/json", authorization: WEBHOOK_SECRET });
    fake.resetCounters();
    const streamed = await inspect(await h.handler(new Request(WEBHOOK_URL, { method: "POST", headers, body: stream })));
    assertEquals(streamed.status, 413, streamed.text);
    assertEquals(fake.counters.rcCalls + fake.counters.writes + fake.counters.lookups, 0);

    // A lying Content-Length (declares > cap, sends a tiny body) is refused too.
    fake.resetCounters();
    const lying = await inspect(await h.handler(buildRequest("POST", WEBHOOK_URL, { "x-forwarded-for": "10.98.0.4", "content-type": "application/json", authorization: WEBHOOK_SECRET, "content-length": String(MAX_JSON_BODY_BYTES + 1) }, "{}")));
    assertEquals(lying.status, 413, lying.text);
    assertEquals(fake.counters.rcCalls + fake.counters.writes + fake.counters.lookups, 0);
  } finally {
    fake.uninstall();
  }
});

Deno.test("stress boundary: forged entitlement claims in the body never grant premium — stored state is RevenueCat's verdict for 64 seeded body shapes", async () => {
  const h = await loadHarness();
  const fake = installFakeBackends();
  try {
    const prng = new Prng(iterationSeed(CAMPAIGN_SEED, 0xf0f0));
    for (let n = 0; n < 64; n++) {
      const userId = prng.uuid();
      fake.profiles.add(userId);
      fake.rcTruth.set(userId, { premium: false, expiresAt: null, product: "" });
      const event: Record<string, unknown> = {
        id: `forged-${prng.hex(12)}`,
        type: prng.pick(["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "PRODUCT_CHANGE", "NON_RENEWING_PURCHASE"]),
        app_user_id: userId,
        entitlement_ids: ["pickle_sensei_pro", "premium"],
        entitlements: { pickle_sensei_pro: { expires_date: null } },
        premium: true,
        expires_at: null,
        expiration_at_ms: Date.now() + 10 * 365 * 86_400_000,
        subscriber: { entitlements: { pickle_sensei_pro: { expires_date: null } } },
        [prng.pick(["is_premium", "verified", "grant", "product_key"])]: prng.pick([true, "pickle_sensei_pro_lifetime"]),
      };
      fake.resetCounters();
      const res = await inspect(await h.handler(buildRequest("POST", WEBHOOK_URL, { "x-forwarded-for": `10.97.${n}.1`, "content-type": "application/json", authorization: WEBHOOK_SECRET }, JSON.stringify({ event }))));
      assertEquals(res.status, 200, res.text);
      assertEquals(fake.counters.rcCalls, 1);
      const stored = fake.billing.get(userId);
      assert(stored, "verdict persisted");
      assertEquals(stored.premium, false, `body claims must not grant premium (seed ${prng.seed}, n=${n})`);
    }
  } finally {
    fake.uninstall();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REPRO (defect) pins — current behaviour, so a fix flips them (repo convention,
// see webhook.test.ts). Each states the concrete failure mode at file:line.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("REPRO (defect): payload with U+0000 → audit row insert refused by Postgres (22P05), handler still answers 200 → no retry, no audit row, replay re-verifies (index.ts:2719-2733, 2762-2763)", async () => {
  const h = await loadHarness();
  const fake = installFakeBackends();
  try {
    const userId = "44444444-4444-4444-8444-444444444444";
    fake.profiles.add(userId);
    fake.rcTruth.set(userId, { premium: true, expiresAt: null, product: "pickle_sensei_pro_lifetime" });
    const eventId = "nul-payload-evt-1";
    const raw = JSON.stringify({ event: { id: eventId, type: "RENEWAL", app_user_id: userId, subscriber_attributes: { note: { value: "x\u0000y" } } } });
    const mk = (ip: string) => buildRequest("POST", WEBHOOK_URL, { "x-forwarded-for": ip, "content-type": "application/json", authorization: WEBHOOK_SECRET }, raw);
    fake.resetCounters();
    const first = await inspect(await h.handler(mk("10.96.0.1")));
    assertEquals(first.status, 200);
    assertEquals(first.json?.verified, true);
    assertEquals(fake.counters.pgErrors, ["log:22P05"], "PostgREST refused the audit upsert");
    assertEquals(fake.webhookEvents.has(eventId), false, "no audit row");
    fake.resetCounters();
    const replay = await inspect(await h.handler(mk("10.96.0.2")));
    assertEquals(replay.status, 200);
    assertEquals(replay.json?.duplicate, undefined, "replay is NOT recognised as duplicate");
    assertEquals(fake.counters.rcCalls, 1, "replay re-verifies with RevenueCat");
  } finally {
    fake.uninstall();
  }
});

Deno.test("REPRO (defect): event.id longer than the btree index ceiling (2704 bytes) → audit row refused (54000), 200 returned, replay re-verifies (index.ts:2684, 2719-2733)", async () => {
  const h = await loadHarness();
  const fake = installFakeBackends();
  try {
    const userId = "55555555-5555-4555-8555-555555555555";
    fake.profiles.add(userId);
    fake.rcTruth.set(userId, { premium: false, expiresAt: null, product: "" });
    const eventId = new Prng(7).hex(3000);
    const raw = JSON.stringify({ event: { id: eventId, type: "TEST", app_user_id: userId } });
    const mk = (ip: string) => buildRequest("POST", WEBHOOK_URL, { "x-forwarded-for": ip, "content-type": "application/json", authorization: WEBHOOK_SECRET }, raw);
    fake.resetCounters();
    const first = await inspect(await h.handler(mk("10.95.0.1")));
    assertEquals(first.status, 200);
    assertEquals(fake.counters.pgErrors, ["log:54000"]);
    assertEquals(fake.webhookEvents.has(eventId), false);
    fake.resetCounters();
    const replay = await inspect(await h.handler(mk("10.95.0.2")));
    assertEquals(replay.status, 200);
    assertEquals(fake.counters.rcCalls, 1, "replay re-verifies");
  } finally {
    fake.uninstall();
  }
});

Deno.test("REPRO (defect): upper-cased uuid alias is verified as a different RevenueCat subscriber and its free verdict overwrites the premium user's row (index.ts:2694-2701, 2643-2652)", async () => {
  const h = await loadHarness();
  const fake = installFakeBackends();
  try {
    const userId = "66666666-6666-4666-8666-66666666abcd";
    fake.profiles.add(userId);
    fake.rcTruth.set(userId, { premium: true, expiresAt: null, product: "pickle_sensei_pro_lifetime" });
    const mk = (event: Record<string, unknown>, ip: string) =>
      buildRequest("POST", WEBHOOK_URL, { "x-forwarded-for": ip, "content-type": "application/json", authorization: WEBHOOK_SECRET }, JSON.stringify({ event }));
    fake.resetCounters();
    const legit = await inspect(await h.handler(mk({ id: "case-1", type: "INITIAL_PURCHASE", app_user_id: userId }, "10.94.0.1")));
    assertEquals(legit.status, 200);
    assertEquals(fake.billing.get(userId)?.premium, true, "precondition: verified premium");

    fake.resetCounters();
    const forged = await inspect(await h.handler(mk({ id: "case-2", type: "EXPIRATION", app_user_id: userId.toUpperCase() }, "10.94.0.2")));
    assertEquals(forged.status, 200);
    assertEquals(forged.json?.verified, true);
    assertEquals(fake.counters.rcIds, [userId.toUpperCase()], "RevenueCat queried for the UPPER-cased id (a different, auto-created subscriber)");
    assertEquals(fake.billing.get(userId)?.premium, false, "the real user's row is now premium=false");
  } finally {
    fake.uninstall();
  }
});

Deno.test("REPRO (defect): subject fan-out is uncapped — one TRANSFER event with N uuids costs N sequential RevenueCat calls + N billing writes (index.ts:2700-2701, 2743-2750)", async () => {
  const h = await loadHarness();
  const fake = installFakeBackends();
  try {
    const prng = new Prng(0xfa0);
    const n = 1000;
    const ids = Array.from({ length: n }, () => prng.uuid());
    for (const id of ids) fake.profiles.add(id);
    const raw = JSON.stringify({ event: { id: "fanout-1000", type: "TRANSFER", transferred_from: ids.slice(0, 500), transferred_to: ids.slice(500) } });
    fake.resetCounters();
    const started = performance.now();
    const res = await inspect(await h.handler(buildRequest("POST", WEBHOOK_URL, { "x-forwarded-for": "10.93.0.1", "content-type": "application/json", authorization: WEBHOOK_SECRET }, raw)));
    const ms = Math.round(performance.now() - started);
    assertEquals(res.status, 200);
    assertEquals(fake.counters.rcCalls, n);
    assertEquals(fake.counters.billingUpserts, n);
    console.log(`[stress] fan-out: ${utf8Len(raw)}-byte event → ${fake.counters.rcCalls} RevenueCat calls, ${fake.counters.billingUpserts} billing writes in ${ms}ms (stubbed)`);
  } finally {
    fake.uninstall();
  }
});
