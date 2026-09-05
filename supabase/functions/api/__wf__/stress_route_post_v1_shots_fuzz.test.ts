/**
 * stress-route-post-v1-shots / lens fuzz-boundary — POST /v1/shots:sync.
 *
 * Seeded fuzz + boundary campaign against the REAL edge handler
 * (../index.ts, in-process via stress_shots_sync_harness.ts) with stubbed
 * Supabase Auth / PostgREST (no Upstash → memory rate limits). Every request
 * is built by `buildCase(iterationSeed(STRESS_SEED, i))` and therefore
 * replays from its 32-bit seed alone.
 *
 * Per request the campaign asserts:
 *   - status ∈ {200} ∪ {400,401,403,404,405,413,415,429} (503 only when the
 *     case injects an upstream fault); any other status — every 5xx — is a
 *     recorded failure with its seed;
 *   - `x-request-id` present and well-formed; a well-formed client id is
 *     echoed, a malformed one is replaced;
 *   - error bodies are the generic `{error:{message}}` envelope, carry no
 *     stack frames / file paths / runtime or database internals, and never
 *     reflect the request's canary or an upstream error detail;
 *   - exactly one access-log line per request, with the same request id;
 *   - NO PostgREST write unless the response is 200, and then exactly one
 *     apply_synced_shot call per parse-valid non-replay shot whose payload
 *     equals the independent oracle's projection;
 *   - acceptedIds / rejected match the oracle (parse verdict + relayed RPC
 *     status) exactly.
 *
 *   STRESS_ITER    iterations (default 250 — suite speed; the reported
 *                  campaign used 3000+)
 *   STRESS_SEED    master seed (default 20260904)
 *   STRESS_REPLAY  comma-separated iteration seeds to replay instead
 *   STRESS_OUT_DIR where fuzz_results.json / fuzz_summary.json land
 *                  (default artifacts/stress-route-post-v1-shots/latest/)
 *
 * Replay one row:
 *   STRESS_REPLAY=<seed> deno test -A --no-check --config deno.json stress_route_post_v1_shots_fuzz.test.ts
 */
import { assert, assertEquals } from "@std/assert";
import {
  canonicalShot,
  captureAccess,
  captureConsole,
  digest,
  envInt,
  histogram,
  isRecord,
  iterationSeed,
  jsonResponse,
  leakFindings,
  loadStressHarness,
  parseJson,
  readBodyText,
  type StressHarness,
  StressNetworkFault,
  type UpstreamCall,
  writeJson,
} from "./stress_shots_sync_harness.ts";
import {
  type BatchOracle,
  buildCase,
  type FuzzCase,
  KNOWN_RPC_STATUSES,
  referenceValidate,
} from "./stress_shots_sync_fuzz.ts";

const ALLOWED_REJECT = new Set([400, 401, 403, 404, 405, 413, 415, 429]);
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const GENERIC_5XX_RE =
  /^(Something went wrong\. Please try again\.|.+ is temporarily unavailable\. Please try again\.)$/;

const STRESS_ITER = envInt("STRESS_ITER", 250);
const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_REPLAY = (Deno.env.get("STRESS_REPLAY") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

interface Row {
  seed: number;
  n: number;
  category: string;
  label: string;
  method: string;
  url: string;
  status: number;
  code: string | null;
  requestId: string | null;
  rpcCalls: number;
  restReads: number;
  restWrites: number;
  unexpectedCalls: number;
  ok: boolean;
  failures: string[];
  /** 404 whose message echoes the raw route (documented allowance). */
  routeEcho: boolean;
  ms: number;
  bodyBytes: number;
  bodyDigest: string;
  bodyPreview: string;
  responsePreview: string;
}

interface Sinks {
  access: ReturnType<typeof captureAccess>;
  console: ReturnType<typeof captureConsole>;
}

function sortedIds(values: unknown): string[] {
  return Array.isArray(values) ? values.map(String).sort() : ["<not an array>"];
}

function sortedRejected(values: unknown): string[] {
  if (!Array.isArray(values)) return ["<not an array>"];
  return values
    .map((entry) => (isRecord(entry) ? `${String(entry.id)}|${String(entry.code)}` : `<${typeof entry}>`))
    .sort();
}

/** The contract lets the route reflect the client's own shot id and a
 * duplicate key back inside `rejected[]`; everywhere else the canary must
 * not appear. */
function withoutRejectedEcho(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.rejected)) return JSON.stringify(body);
  return JSON.stringify({
    ...body,
    rejected: body.rejected.map((r) => (isRecord(r) ? { code: r.code } : r)),
  });
}

function pushIfDifferent(actual: unknown, expected: unknown, what: string, failures: string[]): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${what}: got ${a.slice(0, 400)} want ${e.slice(0, 400)}`);
}

function checkBatch(oracle: BatchOracle, body: unknown, calls: UpstreamCall[], failures: string[]): void {
  if (!isRecord(body)) {
    failures.push("200 body is not an object");
    return;
  }
  pushIfDifferent(sortedIds(body.acceptedIds), oracle.accepted.slice().sort(), "acceptedIds", failures);
  pushIfDifferent(
    sortedRejected(body.rejected),
    oracle.rejected.map((r) => `${r.id}|${r.code}`).sort(),
    "rejected",
    failures,
  );
  if (Array.isArray(body.rejected)) {
    for (const entry of body.rejected) {
      if (!isRecord(entry) || typeof entry.message !== "string" || entry.message.length === 0) {
        failures.push(`rejected entry without a string message: ${JSON.stringify(entry).slice(0, 120)}`);
      }
    }
  }
  const rpcs = calls.filter((c) => c.kind === "rpc");
  if (rpcs.length !== oracle.rpcShots.length) {
    failures.push(`rpc calls ${rpcs.length} ≠ expected ${oracle.rpcShots.length}`);
    return;
  }
  const expectedBodies = oracle.rpcShots.map((shot) => JSON.parse(JSON.stringify({ shot })));
  for (let i = 0; i < rpcs.length; i++) {
    if (!rpcs[i].url.endsWith("/rest/v1/rpc/apply_synced_shot")) {
      failures.push(`rpc #${i} is ${rpcs[i].url}`);
      continue;
    }
    if (JSON.stringify(rpcs[i].body) !== JSON.stringify(expectedBodies[i])) {
      failures.push(
        `rpc #${i} payload ≠ oracle projection: got ${JSON.stringify(rpcs[i].body).slice(0, 300)} want ${
          JSON.stringify(expectedBodies[i]).slice(0, 300)
        }`,
      );
    }
  }
}

function installBackend(h: StressHarness, c: FuzzCase): void {
  h.memory.reset();
  h.memory.shots = c.existingShots.map((id) => ({ id, user_id: c.sub }));
  const exp = c.expectation;
  if (exp.kind === "batch" && exp.rpc.kind !== "accept") {
    const plan = exp.rpc;
    h.memory.rpcResponder = () => {
      if (plan.kind === "status") return plan.status;
      if (plan.kind === "json") return plan.data;
      if (plan.kind === "http-error") {
        return typeof plan.body === "string"
          ? new Response(plan.body, { status: plan.status, headers: { "Content-Type": "text/html" } })
          : jsonResponse(plan.status, plan.body);
      }
      return "accepted";
    };
  }
  if (c.lookupFault) {
    const fault = c.lookupFault;
    h.memory.lookupResponder = () => {
      if (fault === "throw") throw new StressNetworkFault();
      return new Response(fault.body, {
        status: fault.status,
        headers: { "Content-Type": fault.body.startsWith("<") ? "text/html" : "application/json" },
      });
    };
  }
}

function buildRequest(c: FuzzCase): Request | null {
  try {
    return new Request(c.url, {
      method: c.method,
      headers: c.headers,
      body: c.body === undefined ? undefined : (c.body as BodyInit),
    });
  } catch {
    return null;
  }
}

interface Observation {
  response: Response;
  text: string;
  body: unknown;
  calls: UpstreamCall[];
  accessCount: number;
  accessEntry: { requestId: string; status: number } | null;
  consoleLines: string[];
  ms: number;
}

async function fire(h: StressHarness, request: Request, sinks: Sinks): Promise<Observation | { threw: string }> {
  h.drain();
  const accessBefore = sinks.access.entries.length;
  const consoleBefore = sinks.console.lines.length;
  const started = performance.now();
  let response: Response;
  try {
    response = await h.handler(request);
  } catch (error) {
    return { threw: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  const text = await readBodyText(response);
  const ms = performance.now() - started;
  const newEntries = sinks.access.entries.slice(accessBefore);
  return {
    response,
    text,
    body: parseJson(text),
    calls: h.drain(),
    accessCount: newEntries.length,
    accessEntry: newEntries[0] ? { requestId: newEntries[0].requestId, status: newEntries[0].status } : null,
    consoleLines: sinks.console.lines.slice(consoleBefore).map((l) => l.text),
    ms,
  };
}

function evaluate(c: FuzzCase, n: number, obs: Observation, burstStatuses?: number[]): Row {
  const failures: string[] = [];
  const { response, text, body, calls } = obs;
  const status = response.status;
  const exp = c.expectation;
  // Cases whose canary travels in an UPSTREAM answer (not the request): the
  // operator may log it, the client must never see it.
  const upstreamDriven = c.category === "upstream-fault" ||
    (exp.kind === "batch" && exp.rpc.kind !== "accept");

  // 1. Status universe.
  const allowed = new Set<number>([200, ...ALLOWED_REJECT]);
  if (exp.kind === "upstream-fault") allowed.add(503);
  if (!allowed.has(status)) failures.push(`status ${status} outside the allowed set`);

  // 2. Request id.
  const requestId = response.headers.get("x-request-id");
  if (!requestId || !REQUEST_ID_RE.test(requestId)) {
    failures.push(`x-request-id missing/malformed: ${JSON.stringify(requestId)}`);
  }
  if (c.requestIdSent !== null && requestId) {
    if (c.requestIdWellFormed && requestId !== c.requestIdSent.trim()) {
      failures.push(`well-formed client x-request-id not echoed (${JSON.stringify(c.requestIdSent)} → ${requestId})`);
    }
    if (!c.requestIdWellFormed && requestId === c.requestIdSent) {
      failures.push(`malformed client x-request-id echoed verbatim: ${JSON.stringify(requestId)}`);
    }
  }

  // 3. Body hygiene.
  const leaks = leakFindings(text);
  if (leaks.length) failures.push(`body leaks ${leaks.join(",")}: ${text.slice(0, 200)}`);
  // The dispatcher's 404 names the unmatched `METHOD /v1/…` route verbatim
  // (index.ts `errorJson(404, \`Unknown endpoint: ${route}.\`)`), so a canary
  // or an over-long segment in the PATH legitimately comes back there. That
  // echo is tallied (summary.routeEchoes) rather than failed.
  const routeEcho = status === 404 && isRecord(body) && isRecord(body.error) &&
    typeof body.error.message === "string" && /^Unknown endpoint: [A-Za-z]+ \//.test(body.error.message);
  if (status !== 200) {
    if (!isRecord(body) || !isRecord(body.error) || typeof body.error.message !== "string") {
      failures.push(`error body is not {error:{message}}: ${text.slice(0, 200)}`);
    } else {
      if (status >= 500 && !GENERIC_5XX_RE.test(body.error.message)) {
        failures.push(`5xx message not generic: ${body.error.message.slice(0, 200)}`);
      }
      if (!routeEcho && (body.error.message.length > 240 || /[\r\n\t]/.test(body.error.message))) {
        failures.push(`error message unbounded/multiline: ${body.error.message.slice(0, 200)}`);
      }
    }
    if (!routeEcho && text.includes(c.mark)) failures.push("error body reflects the request canary");
  } else if (!isRecord(body) || !Array.isArray(body.acceptedIds) || !Array.isArray(body.rejected)) {
    failures.push(`200 body is not {acceptedIds[],rejected[]}: ${text.slice(0, 200)}`);
  } else if (upstreamDriven) {
    if (JSON.stringify(body).includes(c.mark)) failures.push("upstream error detail reflected to the client");
  } else if (withoutRejectedEcho(body).includes(c.mark)) {
    failures.push("200 body reflects the canary outside rejected[]");
  } else {
    for (const r of body.rejected) {
      const message = isRecord(r) && typeof r.message === "string" ? r.message : "";
      if (message.includes(c.mark) && !/^Duplicate (phase|checkpoint) key: /.test(message)) {
        failures.push(`rejected[].message reflects the canary: ${message.slice(0, 120)}`);
      }
    }
  }

  // 4. Access log.
  if (obs.accessCount !== 1) failures.push(`access log lines: ${obs.accessCount} (want 1)`);
  else if (obs.accessEntry && (obs.accessEntry.requestId !== requestId || obs.accessEntry.status !== status)) {
    failures.push(`access log mismatch: ${JSON.stringify(obs.accessEntry)} vs ${requestId}/${status}`);
  }

  // 5. Upstream discipline.
  const rpcCalls = calls.filter((k) => k.kind === "rpc").length;
  const restReads = calls.filter((k) => k.kind === "rest-read").length;
  const restWrites = calls.filter((k) => k.kind === "rest-write").length;
  const unexpected = calls.filter((k) => k.kind === "unexpected" || k.status === 599);
  if (restWrites > 0) {
    failures.push(`${restWrites} direct PostgREST write(s) — the route must only write through apply_synced_shot`);
  }
  if (unexpected.length > 0) {
    failures.push(
      `${unexpected.length} unmodelled upstream call(s): ${
        unexpected.map((k) => `${k.method} ${k.url}`).join("; ").slice(0, 300)
      }`,
    );
  }
  if (status !== 200 && rpcCalls > 0) failures.push(`${rpcCalls} write RPC(s) despite ${status}`);

  // 6. Operator logs never carry the client's payload.
  if (!upstreamDriven && obs.consoleLines.some((l) => l.includes(c.mark))) {
    failures.push("request canary appeared in console output");
  }

  // 7. Expectation.
  switch (exp.kind) {
    case "reject":
      if (!exp.statuses.includes(status)) {
        failures.push(`expected ${exp.statuses.join("/")}, got ${status}: ${text.slice(0, 160)}`);
      }
      if (restReads + rpcCalls > 0) {
        failures.push(`PostgREST traffic (${restReads} reads, ${rpcCalls} rpcs) on a rejected envelope`);
      }
      break;
    case "batch":
      if (status !== 200) failures.push(`expected 200, got ${status}: ${text.slice(0, 200)}`);
      else checkBatch(exp.oracle, body, calls, failures);
      break;
    case "maybe":
      if (status === 200) checkBatch(exp.oracle, body, calls, failures);
      else {
        if (!exp.statuses.includes(status)) {
          failures.push(`expected 200 or ${exp.statuses.join("/")}, got ${status}: ${text.slice(0, 200)}`);
        }
        if (restReads + rpcCalls > 0) {
          failures.push(`PostgREST traffic (${restReads} reads, ${rpcCalls} rpcs) on ${status}`);
        }
      }
      break;
    case "upstream-fault":
      if (!exp.statuses.includes(status)) {
        failures.push(`expected ${exp.statuses.join("/")} on lookup fault, got ${status}: ${text.slice(0, 200)}`);
      }
      if (rpcCalls > 0) failures.push(`${rpcCalls} write RPC(s) after the replay lookup failed`);
      break;
    case "burst":
      if (burstStatuses && !burstStatuses.includes(status)) {
        failures.push(`burst request ${n}: expected ${burstStatuses.join("/")}, got ${status}: ${text.slice(0, 160)}`);
      }
      if (status === 429) {
        if (!response.headers.get("Retry-After")) failures.push("429 without Retry-After");
        if (rpcCalls > 0) failures.push("write RPC despite 429");
      } else if (status === 200 && rpcCalls !== 1) {
        failures.push(`burst request ${n}: ${rpcCalls} rpc calls (want 1)`);
      }
      break;
  }

  const code = isRecord(body) && isRecord(body.error) && typeof body.error.code === "string" ? body.error.code : null;
  return {
    seed: c.seed,
    n,
    category: c.category,
    label: c.label,
    method: c.method,
    url: c.url.length > 160 ? `${c.url.slice(0, 160)}…(+${c.url.length - 160})` : c.url,
    status,
    code,
    requestId,
    rpcCalls,
    restReads,
    restWrites,
    unexpectedCalls: unexpected.length,
    ok: failures.length === 0,
    failures,
    routeEcho,
    ms: Math.round(obs.ms * 100) / 100,
    bodyBytes: c.bodyBytes,
    bodyDigest: typeof c.body === "string" ? digest(c.body) : c.body ? digest(Array.from(c.body).join(",")) : "-",
    bodyPreview: c.bodyPreview.length > 200 ? `${c.bodyPreview.slice(0, 200)}…` : c.bodyPreview,
    responsePreview: text.length > 200 ? `${text.slice(0, 200)}…` : text,
  };
}

function threwRow(c: FuzzCase, n: number, threw: string): Row {
  return {
    seed: c.seed,
    n,
    category: c.category,
    label: c.label,
    method: c.method,
    url: c.url.slice(0, 160),
    status: -1,
    code: null,
    requestId: null,
    rpcCalls: 0,
    restReads: 0,
    restWrites: 0,
    unexpectedCalls: 0,
    ok: false,
    failures: [`handler promise rejected: ${threw}`],
    routeEcho: false,
    ms: 0,
    bodyBytes: c.bodyBytes,
    bodyDigest: "-",
    bodyPreview: c.bodyPreview.slice(0, 200),
    responsePreview: "",
  };
}

/** The memory rate limiter uses clock-aligned 60s buckets; a burst that
 * straddles a boundary is split across two windows and proves nothing. */
async function waitForFreshMinuteWindow(): Promise<void> {
  const into = Date.now() % 60_000;
  if (into > 57_000) await new Promise((r) => setTimeout(r, 60_050 - into));
}

/** Runs one case; one row per request actually fired. */
async function runCase(
  h: StressHarness,
  c: FuzzCase,
  sinks: Sinks,
): Promise<{ rows: Row[]; unconstructible: boolean }> {
  installBackend(h, c);
  if (c.expectation.kind === "burst") {
    await waitForFreshMinuteWindow();
    const rows: Row[] = [];
    const limit = c.expectation.limit;
    for (let k = 0; k < limit + 1; k++) {
      // Fresh shot id per request so each accepted one is a distinct write.
      const parsed = JSON.parse(c.body as string) as { shots: Record<string, unknown>[] };
      parsed.shots[0].id = `${c.seed.toString(16).padStart(8, "0")}-0000-4000-8000-${k.toString(16).padStart(12, "0")}`;
      const variant = { ...c, body: JSON.stringify(parsed) };
      const request = buildRequest(variant);
      if (!request) return { rows, unconstructible: true };
      const obs = await fire(h, request, sinks);
      rows.push("threw" in obs ? threwRow(c, k, obs.threw) : evaluate(variant, k, obs, k < limit ? [200] : [429]));
    }
    return { rows, unconstructible: false };
  }
  const request = buildRequest(c);
  if (!request) return { rows: [], unconstructible: true };
  const obs = await fire(h, request, sinks);
  return { rows: ["threw" in obs ? threwRow(c, 0, obs.threw) : evaluate(c, 0, obs)], unconstructible: false };
}

Deno.test({
  name: `stress fuzz-boundary: POST /v1/shots:sync ${
    STRESS_REPLAY.length ? `replay ${STRESS_REPLAY.join(",")}` : `${STRESS_ITER} seeded cases (seed ${STRESS_SEED})`
  }`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadStressHarness();
    const sinks: Sinks = { access: captureAccess(), console: captureConsole() };
    const rows: Row[] = [];
    const unconstructible: Array<{ seed: number; label: string }> = [];
    const seeds = STRESS_REPLAY.length
      ? STRESS_REPLAY
      : Array.from({ length: STRESS_ITER }, (_, i) => iterationSeed(STRESS_SEED, i));
    const memBefore = Deno.memoryUsage();
    const started = performance.now();
    try {
      for (const seed of seeds) {
        const c = buildCase(seed);
        const out = await runCase(h, c, sinks);
        rows.push(...out.rows);
        if (out.unconstructible) unconstructible.push({ seed, label: c.label });
      }
    } finally {
      sinks.access.restore();
      sinks.console.restore();
    }
    const elapsedMs = performance.now() - started;
    const memAfter = Deno.memoryUsage();

    const failed = rows.filter((r) => !r.ok);
    const fiveXX = rows.filter((r) => r.status >= 500);
    const categories = [...new Set(rows.map((r) => r.category))];
    const summary = {
      route: "POST /v1/shots:sync",
      masterSeed: STRESS_SEED,
      replay: STRESS_REPLAY,
      iterations: seeds.length,
      requestsExecuted: rows.length,
      unconstructible,
      elapsedMs: Math.round(elapsedMs),
      msPerRequest: Math.round((elapsedMs / Math.max(rows.length, 1)) * 100) / 100,
      heapUsedBeforeMB: Math.round(memBefore.heapUsed / 1048576),
      heapUsedAfterMB: Math.round(memAfter.heapUsed / 1048576),
      rssAfterMB: Math.round(memAfter.rss / 1048576),
      statuses: histogram(rows.map((r) => r.status)),
      categories: histogram(rows.map((r) => r.category)),
      statusByCategory: Object.fromEntries(
        categories.map((cat) => [cat, histogram(rows.filter((r) => r.category === cat).map((r) => r.status))]),
      ),
      errorCodes: histogram(rows.map((r) => r.code ?? "-")),
      rpcCallsTotal: rows.reduce((s, r) => s + r.rpcCalls, 0),
      restWritesTotal: rows.reduce((s, r) => s + r.restWrites, 0),
      consoleLines: sinks.console.lines.length,
      routeEchoes: rows.filter((r) => r.routeEcho).map((r) => ({
        seed: r.seed,
        label: r.label,
        messageLength: r.responsePreview.length,
      })),
      fiveXX: fiveXX.map((r) => ({ seed: r.seed, n: r.n, status: r.status, label: r.label })),
      failed: failed.map((r) => ({
        seed: r.seed,
        n: r.n,
        category: r.category,
        label: r.label,
        status: r.status,
        failures: r.failures,
      })),
      replayCommand: failed.length
        ? `STRESS_REPLAY=${
          [...new Set(failed.map((r) => r.seed))].join(",")
        } deno test -A --no-check --config deno.json stress_route_post_v1_shots_fuzz.test.ts`
        : null,
    };
    const prefix = STRESS_REPLAY.length ? "fuzz_replay" : "fuzz";
    const summaryPath = await writeJson(`${prefix}_summary.json`, summary);
    const rowsPath = await writeJson(`${prefix}_results.json`, rows);
    console.log(
      `[stress fuzz] ${rows.length} requests / ${seeds.length} seeds in ${Math.round(elapsedMs)}ms — statuses ${
        JSON.stringify(summary.statuses)
      } — failed ${failed.length} — 5xx ${fiveXX.length} — ${rowsPath} ${summaryPath}`,
    );
    assertEquals(
      unconstructible,
      [],
      "every generated case must be a constructible Request (otherwise the campaign silently shrinks)",
    );
    assert(rows.length >= seeds.length, "every seed fires at least one request");
    assertEquals(
      failed.map((r) => `${r.seed}#${r.n} ${r.category} ${r.label}: ${r.failures.join(" | ")}`),
      [],
      `${failed.length} failing request(s); replay with ${summary.replayCommand}`,
    );
  },
});

// ── Deterministic boundary pins (always run, whatever STRESS_ITER) ──────────

const ID = "11111111-1111-4111-8111-111111111111";
const PERMIT = "22222222-2222-4222-8222-222222222222";
let pinIp = 0;

function authedPost(body: string, extra: Record<string, string> = {}): Request {
  const sub = "33333333-3333-4333-8333-333333333333";
  const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = `${b64('{"alg":"RS256"}')}.${
    b64(JSON.stringify({ iss: "https://accounts.google.com", sub, exp: Math.floor(Date.now() / 1000) + 600, n: pinIp }))
  }.sig`;
  pinIp += 1;
  return new Request("http://edge.stress.test/functions/v1/api/v1/shots:sync", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
      "x-forwarded-for": `10.${(pinIp >> 8) & 255}.${pinIp & 255}.7`,
      ...extra,
    },
    body,
  });
}

async function withSinks(fn: (h: StressHarness) => Promise<void>): Promise<void> {
  const h = await loadStressHarness();
  const sinks: Sinks = { access: captureAccess(), console: captureConsole() };
  try {
    await fn(h);
  } finally {
    sinks.access.restore();
    sinks.console.restore();
  }
}

Deno.test({
  name: "stress boundary: a body of exactly MAX_JSON_BODY_BYTES is processed; one byte more is 413 with no write",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withSinks(async (h) => {
      const json = JSON.stringify({ shots: [canonicalShot(ID, PERMIT)] });
      const pad = (target: number) => `${json}${" ".repeat(target - new TextEncoder().encode(json).byteLength)}`;
      h.memory.reset();
      const exact = await h.handler(authedPost(pad(5_000_000)));
      const exactBody = await exact.json();
      assertEquals(exact.status, 200, JSON.stringify(exactBody));
      assertEquals(exactBody.acceptedIds, [ID]);
      assertEquals(h.drain().filter((c) => c.kind === "rpc").length, 1);

      h.memory.reset();
      const over = await h.handler(authedPost(pad(5_000_001)));
      const overBody = await over.json();
      assertEquals(over.status, 413, JSON.stringify(overBody));
      assertEquals(typeof overBody.error?.message, "string");
      assertEquals(leakFindings(JSON.stringify(overBody)), []);
      assert(REQUEST_ID_RE.test(over.headers.get("x-request-id") ?? ""));
      assertEquals(h.drain().filter((c) => c.kind === "rpc" || c.kind === "rest-write").length, 0, "no write on 413");

      h.memory.reset();
      const declared = await h.handler(authedPost(json, { "Content-Length": "5000001" }));
      assertEquals(declared.status, 413);
      await declared.body?.cancel();
      assertEquals(h.drain().length, 0, "a declared-oversize body is refused before Auth or PostgREST is consulted");
    }),
});

Deno.test({
  name: "stress boundary: 201 shots is validation.shots_sync with no lookup; 200 valid shots are all written",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withSinks(async (h) => {
      const shots = Array.from(
        { length: 201 },
        (_, i) => canonicalShot(`${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`, PERMIT),
      );
      h.memory.reset();
      const over = await h.handler(authedPost(JSON.stringify({ shots })));
      const overBody = await over.json();
      assertEquals(over.status, 400, JSON.stringify(overBody));
      assertEquals(overBody.error.code, "validation.shots_sync");
      assertEquals(h.drain().filter((c) => c.kind !== "auth").length, 0);

      h.memory.reset();
      const ok = await h.handler(authedPost(JSON.stringify({ shots: shots.slice(0, 200) })));
      const okBody = await ok.json();
      assertEquals(ok.status, 200, JSON.stringify(okBody).slice(0, 300));
      assertEquals(okBody.acceptedIds.length, 200);
      assertEquals(okBody.rejected, []);
      assertEquals(h.drain().filter((c) => c.kind === "rpc").length, 200);
    }),
});

Deno.test({
  name:
    "stress boundary: every documented RPC status is relayed verbatim; unknown statuses collapse to shot.write_failed without SQLSTATE",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withSinks(async (h) => {
      for (const status of KNOWN_RPC_STATUSES) {
        h.memory.reset();
        h.memory.rpcResponder = () => status;
        const response = await h.handler(authedPost(JSON.stringify({ shots: [canonicalShot(ID, PERMIT)] })));
        const body = await response.json();
        assertEquals(response.status, 200);
        assertEquals(body.rejected.map((r: { id: string; code: string }) => [r.id, r.code]), [[ID, status]]);
      }
      for (const status of ["shot.write_failed:23514", "", "Accepted", "accepted\n", "x".repeat(10_000)]) {
        h.memory.reset();
        h.memory.rpcResponder = () => status;
        const response = await h.handler(authedPost(JSON.stringify({ shots: [canonicalShot(ID, PERMIT)] })));
        const body = await response.json();
        assertEquals(response.status, 200);
        assertEquals(body.rejected.map((r: { id: string; code: string }) => [r.id, r.code]), [[
          ID,
          "shot.write_failed",
        ]]);
        assert(!JSON.stringify(body).includes("23514"), "SQLSTATE detail must not reach the client");
      }
    }),
});

Deno.test({
  name:
    "stress probe: an RPC status that collides with an Object.prototype key is never accepted (strict relay contract under STRESS_STRICT=1)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withSinks(async (h) => {
      // apply_synced_shot only returns its documented literals today, so this
      // path is unreachable from any client input. The probe records how the
      // relay (`status in SYNC_STATUS_MESSAGES`, a plain object literal)
      // treats prototype-property names: the safety half (HTTP 200, shot NOT
      // accepted, nothing leaked) is asserted unconditionally; the strict
      // half (code collapses to shot.write_failed with a string message) is
      // the documented P3 and is asserted only under STRESS_STRICT=1.
      const observed: Record<string, unknown> = {};
      const safety: string[] = [];
      const strict: string[] = [];
      for (const status of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
        h.memory.reset();
        h.memory.rpcResponder = () => status;
        const response = await h.handler(authedPost(JSON.stringify({ shots: [canonicalShot(ID, PERMIT)] })));
        const text = await response.text();
        const body = JSON.parse(text);
        observed[status] = { status: response.status, body };
        const entry = body.rejected?.[0] ?? {};
        if (response.status !== 200) safety.push(`${status}: HTTP ${response.status}`);
        if (JSON.stringify(body.acceptedIds) !== "[]") safety.push(`${status}: accepted`);
        if (leakFindings(text).length) safety.push(`${status}: leak ${leakFindings(text).join(",")}`);
        if (entry.code !== "shot.write_failed") strict.push(`${status}: code=${JSON.stringify(entry.code)}`);
        if (typeof entry.message !== "string") strict.push(`${status}: message=${JSON.stringify(entry.message)}`);
      }
      await writeJson("rpc_prototype_status_probe.json", { observed, safety, strict });
      assertEquals(safety, []);
      if (Deno.env.get("STRESS_STRICT") === "1") assertEquals(strict, []);
    }),
});

Deno.test("stress oracle: the reference validator accepts the canonical fixture and rejects each single-field break", () => {
  const ok = referenceValidate(canonicalShot(ID, PERMIT));
  assert(ok.ok);
  const breaks: Array<Record<string, unknown>> = [
    { id: "not-a-uuid" },
    { source: "synthetic" },
    { analysisPermitId: null },
    { sessionId: "" },
    { shotType: " " },
    { cameraView: "front" },
    { capturedAt: "2100-01-01T00:00:00Z" },
    { timestamps: { startMs: -1, contactMs: null, endMs: 0 } },
    { resultKind: "low_confidence" }, // overallScore still 7
    { overallScore: 10.5 },
    { confidence: 1.5 },
    { phases: [{ key: "a", startMs: 0, representativeMs: 0, endMs: 0, confidence: 2 }] },
    {
      checkpoints: [{
        key: "a",
        score: 101,
        confidence: 0,
        band: "green",
        direction: "",
        severity: 0,
        applicable: true,
      }],
    },
    { versionVector: { ...(canonicalShot(ID, PERMIT).versionVector as Record<string, string>), appVersion: "" } },
  ];
  for (const b of breaks) {
    const verdict = referenceValidate(canonicalShot(ID, PERMIT, b));
    if (verdict.ok) throw new Error(`expected rejection for ${JSON.stringify(b)}`);
    assertEquals(verdict.id, "id" in b ? String(b.id) : ID);
    assertEquals(verdict.code, "source" in b ? "shot.non_real_source" : "shot.invalid_payload");
  }
});
