/**
 * stress-edge-http / lens `concurrency` — http.ts helpers + sanitizeUserText
 * under seeded Promise.all bursts against the REAL handler (index.ts loaded
 * in-process; GoTrue / PostgREST / RevenueCat modelled, see
 * stress_edge_http_support.ts).
 *
 *   deno test -A --no-check --config deno.json stress_edge_http_concurrency.test.ts
 *   STRESS_ITER=24 STRESS_BURST=32 …            # campaign scale (≥ 500 interleavings/scenario)
 *   STRESS_SEED=<seed> STRESS_ROUND=<r> … --filter "<scenario>"   # replay one round
 *
 * Every scenario writes <STRESS_OUT_DIR>/<scenario>.json: one row per executed
 * lane (round, seed, action, status, request id, HELD/BROKEN + violations),
 * histograms, invariants, heap before/after, and the replay command per round.
 *
 * Invariants (per request, every scenario):
 *   R1 exactly one x-request-id: echoed iff the client's was well-formed,
 *      otherwise a fresh v4 UUID; ids never collide across a burst
 *   R2 exactly one structured access-log line per request, carrying that id,
 *      the response status, a templated route (no UUID / digit-run segments,
 *      no query string, no bearer), durationMs ≥ 0, and the body's error.code
 *   R3 no response header value contains CR/LF/NUL; JSON bodies carry the
 *      JSON_SECURITY_HEADERS (nosniff, no-store, no-referrer) and still parse
 *   R4 never 5xx (a client-controlled input, cancellation, or clock step must
 *      not surface as 500/503 through these helpers)
 *   R5 bounded wall time for the whole burst (no deadlock / hung stream)
 */
import { assert, assertEquals } from "@std/assert";
import {
  captureAccessLog,
  clientIp,
  constantTimeEqual,
  JSON_SECURITY_HEADERS,
  resolveRequestId,
  routeTemplate,
  sanitizeUserText,
} from "../http.ts";
import {
  bootstrap,
  edgeRequest,
  isRecord,
  Prng,
  readJson,
  sleep,
} from "./xc_concurrency_harness.ts";
import {
  abortingBody,
  CAP_SITES,
  finishReport,
  HEADER_UNSAFE,
  headerValuesViolations,
  hostileText,
  type Invariant,
  laneSeed,
  LATIN1_ONLY,
  loadStressHarness,
  longRun,
  type OutcomeRow,
  printInvariants,
  replayCommand,
  REQUEST_ID_RE,
  reseedLatency,
  rounds,
  roundSeed,
  sanitizedTextViolations,
  streamingBody,
  STRESS_BURST,
  STRESS_ITER,
  STRESS_LATENCY_MS,
  STRESS_SEED,
  type StressHarness,
  UUID_RE,
  withClockSkew,
  writeReport,
} from "./stress_edge_http_support.ts";

const FILE = "stress_edge_http_concurrency.test.ts";
const SCALE = {
  rounds: STRESS_ITER,
  burst: STRESS_BURST,
  latencyMs: STRESS_LATENCY_MS,
};
/** R5 budget: generous per request so a real hang fails, normal load passes. */
const wallBudgetMs = (requests: number) => 5_000 + requests * 120;

interface AccessLine {
  evt?: string;
  requestId?: string;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  code?: string;
}

function parseLines(lines: string[]): AccessLine[] {
  return lines.map((line) => {
    try {
      const parsed = JSON.parse(line);
      return isRecord(parsed) ? (parsed as AccessLine) : {};
    } catch {
      return {};
    }
  });
}

function ip(prng: Prng): string {
  return `10.${prng.int(0, 254)}.${prng.int(0, 254)}.${prng.int(1, 254)}`;
}

/** Per-request R1–R4 checks. `sentId` is what the client sent (or null). */
function requestViolations(
  response: Response,
  sentId: string | null,
  logs: AccessLine[],
  expectStatuses: number[] | null,
  bodyText: string,
): string[] {
  const v: string[] = [];
  const id = response.headers.get("x-request-id");
  if (!id) v.push("R1 missing x-request-id");
  else if (sentId !== null && REQUEST_ID_RE.test(sentId.trim())) {
    if (id !== sentId.trim()) {
      v.push(`R1 well-formed client id not echoed (${id})`);
    }
  } else if (!UUID_RE.test(id)) {
    v.push(`R1 minted id is not a v4 UUID: ${JSON.stringify(id)}`);
  }
  if (sentId !== null && !REQUEST_ID_RE.test(sentId.trim()) && id === sentId) {
    v.push("R1 malformed client id echoed");
  }
  const mine = logs.filter((l) => l.requestId === id);
  if (mine.length !== 1) {
    v.push(`R2 expected 1 access-log line, saw ${mine.length}`);
  } else {
    const l = mine[0];
    if (l.evt !== "api_request") v.push("R2 evt != api_request");
    if (l.status !== response.status) {
      v.push(`R2 log status ${l.status} != ${response.status}`);
    }
    if (typeof l.durationMs !== "number" || l.durationMs < 0) {
      v.push("R2 durationMs missing/negative");
    }
    if (typeof l.route !== "string") v.push("R2 route missing");
    else {
      if (l.route.includes("?")) v.push("R2 route carries a query string");
      if (/bearer|eyJ/i.test(l.route)) v.push("R2 route carries a bearer");
      for (const seg of l.route.split("/")) {
        if (
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            .test(seg)
        ) v.push("R2 route carries a UUID");
        if (/^\d{4,}$/.test(seg)) v.push("R2 route carries a digit run");
      }
    }
    const ct = response.headers.get("content-type") ?? "";
    if (response.status >= 400 && ct.includes("application/json")) {
      let code: string | undefined;
      try {
        const parsed = JSON.parse(bodyText);
        code = isRecord(parsed) && isRecord(parsed.error) &&
            typeof parsed.error.code === "string"
          ? parsed.error.code
          : undefined;
      } catch {
        v.push("R3 JSON error body does not parse");
      }
      if (code !== l.code) {
        v.push(`R2 log code ${String(l.code)} != body code ${String(code)}`);
      }
    }
  }
  v.push(...headerValuesViolations(response.headers));
  const ct = response.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    if (response.headers.get("x-content-type-options") !== "nosniff") {
      v.push("R3 JSON without nosniff");
    }
    if (response.headers.get("cache-control") !== "no-store") {
      v.push("R3 JSON without no-store");
    }
    if (
      response.status !== 429 &&
      response.headers.get("referrer-policy") !==
        JSON_SECURITY_HEADERS["Referrer-Policy"]
    ) {
      v.push("R3 JSON without referrer-policy");
    }
    try {
      JSON.parse(bodyText);
    } catch {
      v.push("R3 JSON body does not parse");
    }
    if (
      response.status >= 500 &&
      /\b(relation|column|syntax|constraint|violates|PGRST|42501|23514)\b/.test(
        bodyText,
      )
    ) {
      v.push("R3 5xx body leaks internal detail");
    }
  }
  if (response.status >= 500) {
    v.push(`R4 ${response.status} for a client-controlled input`);
  }
  if (expectStatuses && !expectStatuses.includes(response.status)) {
    v.push(
      `status ${response.status} not in expected ${expectStatuses.join("/")}`,
    );
  }
  return v;
}

/** Run one lane: seeded pre-delay (the scheduler), the request, the checks. */
async function runLane(
  h: StressHarness,
  prng: Prng,
  build: () => {
    request: Request;
    sentId: string | null;
    expect: number[] | null;
    action: string;
    skewMs?: number;
  },
): Promise<
  {
    row: Omit<OutcomeRow, "scenario" | "round" | "seed" | "lane">;
    body: string;
    response: Response;
  }
> {
  const spec = build();
  await sleep(prng.int(0, STRESS_LATENCY_MS * 2));
  const t0 = performance.now();
  const exec = () => h.handler(spec.request);
  let response: Response;
  try {
    response = spec.skewMs !== undefined
      ? await withClockSkew(spec.skewMs, exec)
      : await exec();
  } catch (error) {
    return {
      row: {
        action: spec.action,
        status: null,
        requestId: null,
        ms: Math.round(performance.now() - t0),
        outcome: "BROKEN",
        violations: [`R4 handler threw: ${String(error)}`],
      },
      body: "",
      response: new Response(null, { status: 599 }),
    };
  }
  const body = await response.text();
  const ms = Math.round(performance.now() - t0);
  // logs are checked after the whole burst (a line may be emitted a tick
  // after the response resolves) — see the caller.
  return {
    row: {
      action: spec.action,
      status: response.status,
      requestId: response.headers.get("x-request-id"),
      ms,
      outcome: "HELD",
      violations: [],
      note: spec.sentId === null
        ? undefined
        : `sent x-request-id=${JSON.stringify(spec.sentId)}`,
    },
    body,
    response,
  };
}

interface LaneResult {
  spec: { sentId: string | null; expect: number[] | null; action: string };
  row: Omit<OutcomeRow, "scenario" | "round" | "seed" | "lane">;
  body: string;
  response: Response;
}

/** Burst `lanes` seeded lanes with Promise.all, capture access logs for the
 * whole burst, then apply R1–R5 to every lane. */
async function burst(
  h: StressHarness,
  seed: number,
  lanes: number,
  pick: (
    prng: Prng,
    lane: number,
  ) => {
    request: Request;
    sentId: string | null;
    expect: number[] | null;
    action: string;
    skewMs?: number;
  },
): Promise<
  {
    results: LaneResult[];
    logs: AccessLine[];
    wallMs: number;
    violationsBurst: string[];
  }
> {
  const captured: string[] = [];
  const restore = captureAccessLog((line) => captured.push(line));
  const t0 = performance.now();
  let results: LaneResult[];
  try {
    results = await Promise.all(
      Array.from({ length: lanes }, async (_, lane) => {
        const prng = new Prng(laneSeed(seed, lane));
        let spec!: ReturnType<typeof pick>;
        const out = await runLane(h, prng, () => {
          spec = pick(prng, lane);
          return spec;
        });
        return {
          spec: {
            sentId: spec.sentId,
            expect: spec.expect,
            action: spec.action,
          },
          ...out,
        };
      }),
    );
    // the handler emits the log line before returning; drain one tick anyway
    await sleep(0);
  } finally {
    restore();
  }
  const wallMs = Math.round(performance.now() - t0);
  const logs = parseLines(captured);
  const violationsBurst: string[] = [];
  const ids = results.map((r) => r.row.requestId).filter((x): x is string =>
    typeof x === "string"
  );
  if (new Set(ids).size !== ids.length) {
    violationsBurst.push("R1 request ids collided inside the burst");
  }
  if (logs.length !== results.length) {
    violationsBurst.push(
      `R2 ${logs.length} log lines for ${results.length} requests`,
    );
  }
  for (const r of results) {
    if (r.row.status === null) continue;
    const v = requestViolations(
      r.response,
      r.spec.sentId,
      logs,
      r.spec.expect,
      r.body,
    );
    if (v.length) {
      r.row.violations.push(...v);
      r.row.outcome = "BROKEN";
    }
  }
  return { results, logs, wallMs, violationsBurst };
}

async function seedUser(h: StressHarness, prng: Prng, tag: string) {
  const sub = `stress-${tag}-${prng.uuid()}`;
  const s = await bootstrap(h, sub, ip(prng));
  if (s.status !== 200) {
    throw new Error(`bootstrap ${tag} → ${s.status} ${JSON.stringify(s.body)}`);
  }
  return { sub, ...s };
}

// ─────────────────────────────────────────────────────────────────────────────
// S1 — http.ts helpers under interleaving (pure functions must be
// re-entrant and deterministic regardless of scheduling)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress-edge-http S1: http.ts helpers are deterministic + safe under interleaved bursts", async () => {
  const scenario = "s1-helpers-interleaved";
  const rows: OutcomeRow[] = [];
  const invariants: Invariant[] = [];
  const heapBefore = Deno.memoryUsage();
  const t0 = performance.now();
  const replay: Record<string, string> = {};
  let maxWall = 0;

  for (const round of rounds()) {
    const seed = roundSeed(round);
    replay[String(round)] = replayCommand(FILE, "S1", round);
    const laneCount = STRESS_BURST * 4;
    const inputs = Array.from({ length: laneCount }, (_, lane) => {
      const prng = new Prng(laneSeed(seed, lane));
      const kind = prng.int(0, 5);
      const cap = [1, 2, 40, 50, 64, 200, 500, 512, 1000][prng.int(0, 8)];
      return { lane, prng, kind, cap };
    });
    // sequential truth
    const sequential = inputs.map(({ prng, kind, cap }) =>
      helperCase(new Prng(prng.seed), kind, cap)
    );
    // interleaved: every lane yields a seeded number of ticks between steps
    const tStart = performance.now();
    const interleaved = await Promise.all(
      inputs.map(async ({ prng, kind, cap }) => {
        const p = new Prng(prng.seed);
        const yields = prng.int(0, 3);
        for (let i = 0; i < yields; i++) await sleep(0);
        const first = helperCase(p, kind, cap);
        for (let i = 0; i < yields; i++) await Promise.resolve();
        return first;
      }),
    );
    maxWall = Math.max(maxWall, performance.now() - tStart);
    inputs.forEach(({ lane, kind, cap }, i) => {
      const v: string[] = [];
      if (JSON.stringify(sequential[i]) !== JSON.stringify(interleaved[i])) {
        v.push("helper result differs between sequential and interleaved runs");
      }
      v.push(...interleaved[i].violations);
      rows.push({
        scenario,
        round,
        seed,
        lane,
        action: `${
          [
            "sanitize",
            "sanitize-long",
            "requestId",
            "routeTemplate",
            "clientIp",
            "constantTimeEqual",
          ][kind]
        }:${cap}`,
        status: null,
        ms: 0,
        outcome: v.length ? "BROKEN" : "HELD",
        violations: v,
        note: interleaved[i].note,
      });
    });
  }

  const broken = rows.filter((r) => r.outcome === "BROKEN");
  invariants.push(
    {
      name:
        "H1 sanitizeUserText output is well-formed, control-free, CR/LF-free, trimmed, ≤ cap, JSON/UTF-8 stable, idempotent",
      holds: !broken.some((r) => r.action.startsWith("sanitize")),
      detail: `${
        rows.filter((r) => r.action.startsWith("sanitize")).length
      } strings`,
    },
    {
      name:
        "H2 resolveRequestId echoes only [A-Za-z0-9._-]{8,64}, mints v4 UUIDs otherwise",
      holds: !broken.some((r) => r.action.startsWith("requestId")),
      detail: `${
        rows.filter((r) => r.action.startsWith("requestId")).length
      } ids`,
    },
    {
      name: "H3 routeTemplate leaves no UUID / ≥4-digit segment",
      holds: !broken.some((r) => r.action.startsWith("routeTemplate")),
      detail: `${
        rows.filter((r) => r.action.startsWith("routeTemplate")).length
      } paths`,
    },
    {
      name:
        "H4 clientIp = cf-connecting-ip else LAST x-forwarded-for hop, trimmed, never a header-injection carrier",
      holds: !broken.some((r) => r.action.startsWith("clientIp")),
      detail: `${
        rows.filter((r) => r.action.startsWith("clientIp")).length
      } header sets`,
    },
    {
      name:
        "H5 constantTimeEqual ≡ byte equality (unicode / length mismatch / empty)",
      holds: !broken.some((r) => r.action.startsWith("constantTimeEqual")),
      detail: `${
        rows.filter((r) => r.action.startsWith("constantTimeEqual")).length
      } pairs`,
    },
    {
      name:
        "H6 helpers are re-entrant: interleaved == sequential for every seed",
      holds: !broken.some((r) =>
        r.violations.some((v) => v.includes("interleaved"))
      ),
      detail: `${rows.length} lanes`,
    },
    {
      name: "R5 bounded wall time",
      holds: maxWall < wallBudgetMs(STRESS_BURST * 4),
      detail: `max round ${Math.round(maxWall)}ms < ${
        wallBudgetMs(STRESS_BURST * 4)
      }ms`,
    },
  );
  printInvariants(scenario, invariants);
  const report = finishReport({
    scenario,
    file: FILE,
    label: "http.ts helper fuzz under interleaving",
    baseSeed: STRESS_SEED,
    scale: SCALE,
    rows,
    invariants,
    observations: { brokenSample: broken.slice(0, 10) },
    durationMs: Math.round(performance.now() - t0),
    heap: { before: heapBefore, after: Deno.memoryUsage() },
    replay,
  });
  console.log(
    `[stress] wrote ${await writeReport(
      report,
    )} (${report.executed} lanes, ${report.broken} broken)`,
  );
  for (const inv of invariants) assert(inv.holds, `${inv.name}: ${inv.detail}`);
});

function helperCase(
  prng: Prng,
  kind: number,
  cap: number,
): { out: unknown; violations: string[]; note?: string } {
  const v: string[] = [];
  switch (kind) {
    case 0:
    case 1: {
      const input = kind === 0
        ? hostileText(prng, 24)
        : longRun(prng, Math.max(0, cap - 2), cap * 2 + 3);
      const out = sanitizeUserText(input, cap);
      v.push(...sanitizedTextViolations(out, cap));
      if (sanitizeUserText(out, cap) !== out) v.push("not idempotent");
      // header-safe: Latin-1 output must be a legal header value; any output
      // must be free of the bytes Headers rejects
      if (LATIN1_ONLY.test(out)) {
        try {
          new Headers({ "x-stress": out });
        } catch (e) {
          v.push(`Headers rejected sanitized Latin-1 value: ${String(e)}`);
        }
      }
      // a cap never splits a surrogate pair, and truncation only drops from
      // the end: the output is a prefix (as code points) of the unbounded output
      const unbounded = sanitizeUserText(input, 1_000_000);
      if (!unbounded.startsWith(out)) {
        v.push("capped output is not a prefix of the uncapped output");
      }
      return {
        out,
        violations: v,
        note: `in=${Array.from(input).length}cp out=${
          Array.from(out).length
        }cp`,
      };
    }
    case 2: {
      const kinds = [
        () => prng.uuid(),
        () => "abcdefgh",
        () => "a".repeat(64),
        () => "a".repeat(65),
        () => "a".repeat(7),
        () => "   " + prng.uuid() + "  ",
        () => hostileText(prng, 6).replace(HEADER_UNSAFE, ""),
        () => "../../etc/passwd",
        () => "id with space",
        () => "😀".repeat(8),
        () => "",
        () => "a".repeat(8) + "\u200b",
      ];
      const sent = kinds[prng.int(0, kinds.length - 1)]();
      let request: Request;
      try {
        request = new Request("http://edge.xc.test/x", {
          headers: { "x-request-id": sent },
        });
      } catch {
        return {
          out: "header-rejected",
          violations: v,
          note: `Headers rejected ${JSON.stringify(sent)}`,
        };
      }
      const out = resolveRequestId(request);
      const trimmed = request.headers.get("x-request-id")?.trim() ?? "";
      if (REQUEST_ID_RE.test(trimmed)) {
        if (out !== trimmed) v.push("well-formed id not echoed");
      } else if (!UUID_RE.test(out)) v.push(`minted id not a v4 UUID: ${out}`);
      if (!REQUEST_ID_RE.test(trimmed) && trimmed !== "" && out === trimmed) {
        v.push("malformed id echoed");
      }
      // a minted id is random by design — normalize it for the determinism check
      return {
        out: REQUEST_ID_RE.test(trimmed) ? out : "<minted-uuid>",
        violations: v,
        note: `sent=${JSON.stringify(sent).slice(0, 40)}`,
      };
    }
    case 3: {
      const segs = [
        "v1",
        "shots",
        "sessions",
        prng.uuid(),
        String(prng.int(1000, 99_999_999)),
        String(prng.int(0, 999)),
        "finalize",
        hostileText(prng, 3).replace(/\//g, ""),
      ];
      const path = "/" + prng.shuffle(segs).slice(0, prng.int(1, 6)).join("/");
      const out = routeTemplate(path);
      for (const seg of out.split("/")) {
        if (
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            .test(seg)
        ) v.push("UUID segment survived");
        if (/^\d{4,}$/.test(seg)) v.push("digit run survived");
      }
      if (out.split("/").length !== path.split("/").length) {
        v.push("segment count changed");
      }
      return { out, violations: v };
    }
    case 4: {
      const hops = Array.from({ length: prng.int(1, 5) }, () => ip(prng));
      const cf = prng.int(0, 1) === 1 ? ip(prng) : null;
      // header values are ByteStrings: keep the junk Latin-1 and CR/LF/NUL-free
      const junk = prng.int(0, 2) === 0
        ? hostileText(prng, 3).replace(HEADER_UNSAFE, "")
        : "";
      const xff = hops.join(prng.int(0, 1) ? ", " : ",") +
        (junk ? `, ${junk}` : "");
      const headers = new Headers({ "x-forwarded-for": xff });
      if (cf) headers.set("cf-connecting-ip", cf);
      const out = clientIp(new Request("http://edge.xc.test/x", { headers }));
      // oracle: last non-empty trimmed hop (whitespace-only junk is skipped)
      const expected = cf ??
        (junk.trim() ? junk.trim() : hops[hops.length - 1]);
      if (out !== expected) {
        v.push(
          `clientIp ${JSON.stringify(out)} != ${JSON.stringify(expected)}`,
        );
      }
      if (/[\r\n\0,]/.test(out)) v.push("clientIp carries CR/LF/NUL/comma");
      return { out, violations: v };
    }
    default: {
      const a = hostileText(prng, 4);
      const b = prng.int(0, 1) ? a : hostileText(prng, 4);
      const out = constantTimeEqual(a, b);
      // byte equality (lone surrogates encode as U+FFFD, so compare encodings)
      const enc = new TextEncoder();
      const ea = enc.encode(a), eb = enc.encode(b);
      const expected = ea.length === eb.length &&
        ea.every((x, i) => x === eb[i]);
      if (out !== expected) {
        v.push(`constantTimeEqual ${out} != byte-equality ${expected}`);
      }
      return { out, violations: v };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// S2 — mixed real-handler burst: public, unauthenticated, malformed, oversize,
// cancelled, and authed requests interleaved; R1–R5 on every one
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress-edge-http S2: mixed real-handler bursts keep one id + one log line per request, no 5xx", async () => {
  const h = await loadStressHarness();
  const scenario = "s2-handler-burst-mixed";
  const rows: OutcomeRow[] = [];
  const invariants: Invariant[] = [];
  const heapBefore = Deno.memoryUsage();
  const t0 = performance.now();
  const replay: Record<string, string> = {};
  const burstViolations: string[] = [];
  let maxWall = 0;
  let unmodelled = 0;

  for (const round of rounds()) {
    const seed = roundSeed(round);
    replay[String(round)] = replayCommand(FILE, "S2", round);
    h.fake.reset(seed, STRESS_LATENCY_MS);
    h.resetLayer();
    reseedLatency(seed);
    const setup = new Prng(seed ^ 0xabcdef);
    const user = await seedUser(h, setup, `s2-${round}`);

    const { results, wallMs, violationsBurst } = await burst(
      h,
      seed,
      STRESS_BURST,
      (prng, lane) => {
        const laneIp = ip(prng);
        const idKinds = [
          null,
          prng.uuid(),
          "a".repeat(65),
          "short",
          "id with space",
          "../etc",
          "ok-" + prng.uuid().slice(0, 20),
        ];
        const sentId = idKinds[prng.int(0, idKinds.length - 1)];
        const headers: Record<string, string> = {};
        if (sentId !== null) headers["x-request-id"] = sentId;
        const action = [
          "healthz",
          "legal",
          "unknown-route",
          "bad-bearer",
          "oversize-content-length",
          "invalid-json",
          "aborted-body",
          "me",
          "consent-hostile",
          "onboarding-hostile",
          "path-uuid-404",
          "oversize-stream",
        ][prng.int(0, 11 + (lane === 0 ? 0 : -1))]; // oversize-stream only on lane 0 (5 MB)
        switch (action) {
          case "healthz":
            return {
              action,
              sentId,
              expect: [200, 429],
              request: edgeRequest("GET", "/healthz", { ip: laneIp, headers }),
            };
          case "legal":
            return {
              action,
              sentId,
              expect: [200, 429],
              request: edgeRequest(
                "GET",
                ["/privacy", "/terms", "/support"][prng.int(0, 2)],
                { ip: laneIp, headers },
              ),
            };
          case "unknown-route":
            return {
              action,
              sentId,
              expect: [404, 429],
              request: edgeRequest(
                "GET",
                `/v1/${
                  hostileText(prng, 2).replace(/[\/\r\n\0?#]/g, "") || "nope"
                }`,
                { ip: laneIp, token: user.accessToken, headers },
              ),
            };
          case "path-uuid-404":
            return {
              action,
              sentId,
              expect: [404, 429],
              request: edgeRequest(
                "GET",
                `/v1/nothing/${prng.uuid()}/${prng.int(10_000, 99_999)}`,
                { ip: laneIp, token: user.accessToken, headers },
              ),
            };
          case "bad-bearer":
            return {
              action,
              sentId,
              expect: [401, 429],
              request: edgeRequest("GET", "/v1/me", {
                ip: laneIp,
                token: `bad.${prng.uuid()}.token`,
                headers,
              }),
            };
          case "oversize-content-length":
            return {
              action,
              sentId,
              expect: [413, 429],
              request: edgeRequest("POST", "/v1/me/consent/grant", {
                ip: laneIp,
                token: user.accessToken,
                body: { scope: "model_training", consentVersion: "v" },
                headers: {
                  ...headers,
                  "content-length": String(5_000_001 + prng.int(0, 1_000_000)),
                },
              }),
            };
          case "invalid-json": {
            const r = edgeRequest("POST", "/v1/me/consent/grant", {
              ip: laneIp,
              token: user.accessToken,
              headers,
            });
            return {
              action,
              sentId,
              expect: [400, 429],
              request: new Request(r, {
                method: "POST",
                body: "{" + hostileText(prng, 5),
                headers: [...r.headers.entries(), [
                  "content-type",
                  "application/json",
                ]],
              }),
            };
          }
          case "aborted-body": {
            const r = edgeRequest("POST", "/v1/me/consent/grant", {
              ip: laneIp,
              token: user.accessToken,
              headers,
            });
            const chunks = Array.from(
              { length: prng.int(0, 3) },
              () => new TextEncoder().encode(hostileText(prng, 4)),
            );
            return {
              action,
              sentId,
              expect: [400, 429],
              request: new Request(r, {
                method: "POST",
                body: abortingBody(chunks),
                headers: [...r.headers.entries(), [
                  "content-type",
                  "application/json",
                ]],
              }),
            };
          }
          case "oversize-stream": {
            const r = edgeRequest("POST", "/v1/me/consent/grant", {
              ip: laneIp,
              token: user.accessToken,
              headers,
            });
            return {
              action,
              sentId,
              expect: [413, 429],
              request: new Request(r, {
                method: "POST",
                body: streamingBody(5_000_000 + 65_536, 1 << 20),
                headers: [...r.headers.entries(), [
                  "content-type",
                  "application/json",
                ]],
              }),
            };
          }
          case "me":
            return {
              action,
              sentId,
              expect: [200, 429],
              request: edgeRequest("GET", "/v1/me", {
                ip: laneIp,
                token: user.accessToken,
                headers,
              }),
            };
          case "consent-hostile":
            return {
              action,
              sentId,
              expect: [200, 400, 429],
              request: edgeRequest(
                "POST",
                prng.int(0, 3) === 0
                  ? "/v1/me/consent/withdraw"
                  : "/v1/me/consent/grant",
                {
                  ip: laneIp,
                  token: user.accessToken,
                  headers,
                  body: {
                    scope: [
                      "video_analysis",
                      "model_training",
                      "evaluation_telemetry",
                      hostileText(prng, 2),
                    ][prng.int(0, 3)],
                    consentVersion: hostileText(prng, 8),
                    source: hostileText(prng, 6),
                    device: longRun(prng, 100, 700),
                    captureMode: hostileText(prng, 6),
                  },
                },
              ),
            };
          default:
            return {
              action,
              sentId,
              expect: [200, 400, 429],
              request: edgeRequest("PUT", "/v1/me/onboarding", {
                ip: laneIp,
                token: user.accessToken,
                headers,
                body: {
                  handedness:
                    ["right", "left", hostileText(prng, 1)][prng.int(0, 2)],
                  skillLevel: hostileText(prng, 6),
                  goal: hostileText(prng, 6),
                  biggestProblem: hostileText(prng, 30),
                  firstName: prng.int(0, 1) ? hostileText(prng, 5) : undefined,
                  gender: [
                    "female",
                    "male",
                    "nonbinary",
                    "prefer_not_to_say",
                    undefined,
                  ][prng.int(0, 4)],
                },
              }),
            };
        }
      },
    );
    maxWall = Math.max(maxWall, wallMs);
    burstViolations.push(...violationsBurst.map((v) => `round ${round}: ${v}`));
    unmodelled += h.unmodelled.length;
    results.forEach((r, lane) =>
      rows.push({ scenario, round, seed, lane, ...r.row })
    );
  }

  const broken = rows.filter((r) => r.outcome === "BROKEN");
  const byRule = (rule: string) =>
    broken.filter((r) => r.violations.some((v) => v.startsWith(rule)));
  invariants.push(
    {
      name:
        "R1 one x-request-id per response; well-formed echoed, malformed replaced by a v4 UUID; no collisions",
      holds: byRule("R1").length === 0 &&
        !burstViolations.some((v) => v.includes("R1")),
      detail: `${rows.length} requests, ${byRule("R1").length} violations`,
    },
    {
      name:
        "R2 exactly one access-log line per request (id, status, templated route, code)",
      holds: byRule("R2").length === 0 &&
        !burstViolations.some((v) => v.includes("R2")),
      detail: `${
        byRule("R2").length
      } violations; ${burstViolations.length} burst-level`,
    },
    {
      name:
        "R3 header values CR/LF-free; JSON responses carry security headers and parse",
      holds: byRule("R3").length === 0,
      detail: `${byRule("R3").length} violations`,
    },
    {
      name:
        "R4 no 5xx for any client-controlled input / cancelled upload / oversize body",
      holds: byRule("R4").length === 0,
      detail: `${byRule("R4").length} violations`,
    },
    {
      name: "R6 every action landed in its expected status set",
      holds: !broken.some((r) =>
        r.violations.some((v) => v.startsWith("status "))
      ),
      detail: `${
        broken.filter((r) => r.violations.some((v) => v.startsWith("status ")))
          .length
      } unexpected statuses`,
    },
    {
      name: "R7 the layered PostgREST model saw no unmodelled verb",
      holds: unmodelled === 0,
      detail: `${unmodelled} unmodelled`,
    },
    {
      name: "R5 bounded wall time per burst",
      holds: maxWall < wallBudgetMs(STRESS_BURST),
      detail: `max ${maxWall}ms < ${wallBudgetMs(STRESS_BURST)}ms`,
    },
  );
  printInvariants(scenario, invariants);
  const report = finishReport({
    scenario,
    file: FILE,
    label: "mixed real-handler bursts",
    baseSeed: STRESS_SEED,
    scale: SCALE,
    rows,
    invariants,
    observations: { burstViolations, brokenSample: broken.slice(0, 10) },
    durationMs: Math.round(performance.now() - t0),
    heap: { before: heapBefore, after: Deno.memoryUsage() },
    replay,
  });
  console.log(
    `[stress] wrote ${await writeReport(
      report,
    )} (${report.executed} requests, ${report.broken} broken)`,
  );
  for (const inv of invariants) assert(inv.holds, `${inv.name}: ${inv.detail}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// S3 — hostile free text through the sanitizing routes, two actors on the
// same profile row / consent ledger: stored text is sanitized, no torn row,
// consent fold is consistent with the ledger
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress-edge-http S3: hostile text routes — sanitized storage, no torn profile row, consistent consent fold", async () => {
  const h = await loadStressHarness();
  const scenario = "s3-hostile-text-two-actors";
  const rows: OutcomeRow[] = [];
  const invariants: Invariant[] = [];
  const heapBefore = Deno.memoryUsage();
  const t0 = performance.now();
  const replay: Record<string, string> = {};
  let maxWall = 0;
  let tornRows = 0;
  let unsanitizedStored = 0;
  let foldMismatch = 0;
  let responseMismatch = 0;
  let onboarding200 = 0, consent200 = 0;

  for (const round of rounds()) {
    const seed = roundSeed(round);
    replay[String(round)] = replayCommand(FILE, "S3", round);
    h.fake.reset(seed, STRESS_LATENCY_MS);
    h.resetLayer();
    reseedLatency(seed);
    const setup = new Prng(seed ^ 0x3333);
    // two devices (sessions) of ONE user → the same profile row / ledger
    const user = await seedUser(h, setup, `s3-${round}`);
    const second = await bootstrap(h, user.sub, ip(setup));
    assertEquals(second.status, 200, "second device bootstrap");
    const tokens = [user.accessToken, second.accessToken];
    const goals = [
      "Consistency",
      "Power",
      "Placement",
      "Spin",
      "Footwork",
      "Reset",
    ];
    const patches: Array<Record<string, unknown>> = [];

    const { results, wallMs } = await burst(
      h,
      seed,
      STRESS_BURST,
      (prng, lane) => {
        const token = tokens[lane % 2];
        const laneIp = ip(prng);
        if (prng.int(0, 1) === 0) {
          const body = {
            handedness: prng.int(0, 1) ? "right" : "left",
            skillLevel:
              ["Beginner", "Intermediate", "Advanced"][prng.int(0, 2)] +
              hostileText(prng, 3),
            goal: goals[prng.int(0, goals.length - 1)] + hostileText(prng, 2),
            biggestProblem: hostileText(prng, 20) + " problem " + lane,
            firstName: prng.int(0, 2) === 0
              ? undefined
              : hostileText(prng, 4) + "N" + lane,
          };
          patches.push(body);
          return {
            action: "onboarding",
            sentId: null,
            expect: [200, 400, 429],
            request: edgeRequest("PUT", "/v1/me/onboarding", {
              ip: laneIp,
              token,
              body,
            }),
          };
        }
        const withdraw = prng.int(0, 2) === 0;
        return {
          action: withdraw ? "consent-withdraw" : "consent-grant",
          sentId: null,
          expect: [200, 429],
          request: edgeRequest(
            "POST",
            withdraw ? "/v1/me/consent/withdraw" : "/v1/me/consent/grant",
            {
              ip: laneIp,
              token,
              body: {
                scope: [
                  "video_analysis",
                  "model_training",
                  "evaluation_telemetry",
                ][prng.int(0, 2)],
                consentVersion: "model-training-v1" + hostileText(prng, 4),
                source: hostileText(prng, 5),
                device: hostileText(prng, 40),
                captureMode: hostileText(prng, 5),
              },
            },
          ),
        };
      },
    );
    maxWall = Math.max(maxWall, wallMs);

    // stored state
    const profile = h.fake.tables.profiles.find((p) => p.id === user.sub);
    assert(profile, "profile row exists");
    for (
      const col of [
        "skill_level",
        "primary_goal",
        "biggest_problem",
        "first_name",
      ]
    ) {
      const val = profile[col];
      if (
        typeof val === "string" && sanitizedTextViolations(val, 1_000).length
      ) unsanitizedStored += 1;
    }
    for (const rec of h.consentRecords) {
      for (
        const val of [
          rec.consent_version,
          rec.source,
          rec.capture_mode,
          typeof rec.device === "string" ? rec.device : null,
        ]
      ) {
        if (
          typeof val === "string" && sanitizedTextViolations(val, 1_000).length
        ) unsanitizedStored += 1;
      }
    }
    // no torn row: the stored (skill_level, handedness, primary_goal, biggest_problem, first_name?) must be
    // one accepted PUT's payload — biggest_problem carries the lane tag, so match by it
    const accepted = results.filter((r) =>
      r.spec.action === "onboarding" && r.row.status === 200
    );
    onboarding200 += accepted.length;
    if (accepted.length > 0) {
      const tag = String(profile.biggest_problem ?? "");
      const winnerLane = Number(tag.slice(tag.lastIndexOf(" ") + 1));
      const winner = results[winnerLane];
      const winnerBody = winner && winner.row.status === 200
        ? JSON.parse(winner.body)
        : null;
      if (!isRecord(winnerBody) || !isRecord(winnerBody.profile)) tornRows += 1;
      else {
        const p = winnerBody.profile;
        for (
          const col of [
            "skill_level",
            "handedness",
            "primary_goal",
            "biggest_problem",
            "focus_checkpoint",
          ]
        ) {
          if (p[col] !== profile[col]) tornRows += 1;
        }
      }
      // each 200 response echoed the sanitized version of ITS OWN payload
      for (const r of accepted) {
        const body = JSON.parse(r.body);
        const p = isRecord(body) && isRecord(body.profile) ? body.profile : {};
        const lane = results.indexOf(r);
        const sent = patches.find((x) =>
          String(x.biggestProblem).endsWith(` problem ${lane}`)
        );
        if (!sent) {
          responseMismatch += 1;
          continue;
        }
        if (
          p.biggest_problem !==
            sanitizeUserText(String(sent.biggestProblem), 1_000)
        ) responseMismatch += 1;
        if (p.primary_goal !== sanitizeUserText(String(sent.goal), 200)) {
          responseMismatch += 1;
        }
        if (p.skill_level !== sanitizeUserText(String(sent.skillLevel), 200)) {
          responseMismatch += 1;
        }
      }
    }
    // consent fold: the final GET status must equal the fold of the ledger
    const status = await h.handler(
      edgeRequest("GET", "/v1/me/consent/status", {
        ip: ip(setup),
        token: user.accessToken,
      }),
    );
    const statusBody = await readJson(status);
    consent200 += results.filter((r) =>
      r.spec.action.startsWith("consent") && r.row.status === 200
    ).length;
    if (status.status !== 200) {
      foldMismatch += 1;
    } else {
      const scopes = Array.isArray(statusBody.scopes)
        ? statusBody.scopes as Array<Record<string, unknown>>
        : [];
      for (const s of scopes) {
        const last = h.consentRecords.filter((r) =>
          r.scope === s.scope
        ).at(-1) ?? null;
        if ((last?.action === "grant") !== s.active) {
          foldMismatch += 1;
        }
        if (
          (last?.consent_version ?? null) !== s.consentVersion
        ) {
          foldMismatch += 1;
        }
      }
      // every grant/withdraw response was a fold of SOME prefix: active/inactive is boolean, version sanitized
      for (
        const r of results.filter((r) =>
          r.spec.action.startsWith("consent") && r.row.status === 200
        )
      ) {
        const b = JSON.parse(r.body);
        const sc = isRecord(b) && Array.isArray(b.scopes)
          ? b.scopes as Array<Record<string, unknown>>
          : [];
        if (sc.length !== 3) {
          foldMismatch += 1;
        }
        for (const s of sc) {
          if (
            typeof s.consentVersion === "string" &&
            sanitizedTextViolations(s.consentVersion, 64).length
          ) {
            foldMismatch += 1;
          }
        }
      }
    }
    results.forEach((r, lane) =>
      rows.push({ scenario, round, seed, lane, ...r.row })
    );
  }

  const broken = rows.filter((r) => r.outcome === "BROKEN");
  invariants.push(
    {
      name:
        "T1 every stored free-text column is sanitized (no control/zero-width/bidi/CRLF/NUL, trimmed)",
      holds: unsanitizedStored === 0,
      detail: `${unsanitizedStored} unsanitized stored values`,
    },
    {
      name:
        "T2 two devices racing PUT /v1/me/onboarding never leave a torn profile row (stored row == one winner's full patch)",
      holds: tornRows === 0,
      detail: `${tornRows} torn; ${onboarding200} accepted PUTs`,
    },
    {
      name:
        "T3 each 200 onboarding response echoes the sanitized form of ITS OWN payload",
      holds: responseMismatch === 0,
      detail: `${responseMismatch} mismatches`,
    },
    {
      name:
        "T4 consent status == fold(ledger) after concurrent grants/withdraws; every response is a 3-scope fold with sanitized versions",
      holds: foldMismatch === 0,
      detail: `${foldMismatch} mismatches; ${consent200} consent writes`,
    },
    {
      name: "R1–R4 per request",
      holds: broken.length === 0,
      detail: `${broken.length} broken of ${rows.length}`,
    },
    {
      name: "R5 bounded wall time per burst",
      holds: maxWall < wallBudgetMs(STRESS_BURST),
      detail: `max ${maxWall}ms < ${wallBudgetMs(STRESS_BURST)}ms`,
    },
  );
  printInvariants(scenario, invariants);
  const report = finishReport({
    scenario,
    file: FILE,
    label: "hostile text, two actors on one row",
    baseSeed: STRESS_SEED,
    scale: SCALE,
    rows,
    invariants,
    observations: {
      onboarding200,
      consent200,
      brokenSample: broken.slice(0, 10),
    },
    durationMs: Math.round(performance.now() - t0),
    heap: { before: heapBefore, after: Deno.memoryUsage() },
    replay,
  });
  console.log(
    `[stress] wrote ${await writeReport(
      report,
    )} (${report.executed} requests, ${report.broken} broken)`,
  );
  for (const inv of invariants) assert(inv.holds, `${inv.name}: ${inv.detail}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// S4 — rotation / logout during in-flight requests; clock skew under a live
// burst. Statuses may be 200 or 401 depending on the interleaving; never 5xx,
// never a request after the logout resolved that still succeeds on that bearer
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress-edge-http S4: refresh/logout during requests + clock skew — no 5xx, id/log per request, post-logout 401", async () => {
  const h = await loadStressHarness();
  const scenario = "s4-session-race-clock-skew";
  const rows: OutcomeRow[] = [];
  const invariants: Invariant[] = [];
  const heapBefore = Deno.memoryUsage();
  const t0 = performance.now();
  const replay: Record<string, string> = {};
  let maxWall = 0;
  let postLogoutSuccess = 0;
  let postLogoutChecked = 0;
  let retryAfterBad = 0;
  let refresh200 = 0, refreshOther = 0;

  for (const round of rounds()) {
    const seed = roundSeed(round);
    replay[String(round)] = replayCommand(FILE, "S4", round);
    h.fake.reset(seed, STRESS_LATENCY_MS);
    h.resetLayer();
    reseedLatency(seed);
    const setup = new Prng(seed ^ 0x4444);
    const user = await seedUser(h, setup, `s4-${round}`);
    const other = await seedUser(h, setup, `s4o-${round}`);
    const logoutLane = setup.int(0, STRESS_BURST - 1);
    const refreshLane = (logoutLane + 1 + setup.int(0, STRESS_BURST - 2)) %
      STRESS_BURST;

    const { results, wallMs } = await burst(
      h,
      seed,
      STRESS_BURST,
      (prng, lane) => {
        const laneIp = ip(prng);
        const skew = prng.int(0, 3) === 0
          ? (prng.int(0, 1) ? 1 : -1) * prng.int(0, 120_000)
          : undefined;
        if (lane === logoutLane) {
          return {
            action: "logout",
            sentId: null,
            expect: [204, 429],
            skewMs: skew,
            request: edgeRequest("POST", "/v1/auth/logout", {
              ip: laneIp,
              token: user.accessToken,
            }),
          };
        }
        if (lane === refreshLane) {
          return {
            action: "refresh",
            sentId: null,
            expect: [200, 401, 429],
            skewMs: skew,
            request: edgeRequest("POST", "/v1/auth/refresh", {
              ip: laneIp,
              body: { refreshToken: user.refreshToken },
            }),
          };
        }
        const victim = prng.int(0, 3) === 0 ? other : user;
        const kind = prng.int(0, 2);
        if (kind === 0) {
          return {
            action: victim === user ? "me-during-race" : "me-other-user",
            sentId: null,
            expect: [200, 401, 429],
            skewMs: skew,
            request: edgeRequest("GET", "/v1/me", {
              ip: laneIp,
              token: victim.accessToken,
            }),
          };
        }
        if (kind === 1) {
          return {
            action: victim === user
              ? "consent-during-race"
              : "consent-other-user",
            sentId: null,
            expect: [200, 401, 429],
            skewMs: skew,
            request: edgeRequest("POST", "/v1/me/consent/grant", {
              ip: laneIp,
              token: victim.accessToken,
              body: {
                scope: "model_training",
                consentVersion: "model-training-v1",
                source: hostileText(prng, 3),
                device: hostileText(prng, 10),
              },
            }),
          };
        }
        return {
          action: "healthz-skew",
          sentId: null,
          expect: [200, 429],
          skewMs: skew,
          request: edgeRequest("GET", "/healthz", { ip: laneIp }),
        };
      },
    );
    maxWall = Math.max(maxWall, wallMs);
    for (const r of results) {
      if (r.row.status === 429) {
        const ra = Number(r.response.headers.get("retry-after"));
        if (!Number.isFinite(ra) || ra < 1) retryAfterBad += 1;
      }
      if (r.spec.action === "refresh") {
        r.row.status === 200 ? refresh200++ : refreshOther++;
      }
      // other user's requests must never be disturbed by the race
      if (
        r.spec.action.endsWith("other-user") && r.row.status !== 200 &&
        r.row.status !== 429
      ) {
        r.row.violations.push(
          "other user's request failed during a stranger's logout/refresh",
        );
        r.row.outcome = "BROKEN";
      }
    }
    // after the burst (logout resolved): the logged-out bearer must be refused
    const logoutResult = results[logoutLane];
    if (logoutResult.row.status === 204) {
      const after = await Promise.all(
        Array.from({ length: 4 }, () =>
          h.handler(
            edgeRequest("GET", "/v1/me", {
              ip: ip(setup),
              token: user.accessToken,
            }),
          )),
      );
      for (const a of after) {
        postLogoutChecked += 1;
        await a.body?.cancel();
        if (a.status === 200) postLogoutSuccess += 1;
      }
    }
    results.forEach((r, lane) =>
      rows.push({ scenario, round, seed, lane, ...r.row })
    );
  }

  const broken = rows.filter((r) => r.outcome === "BROKEN");
  invariants.push(
    {
      name:
        "L1 logout/refresh racing in-flight requests never yields 5xx or a handler throw",
      holds: !broken.some((r) => r.violations.some((v) => v.startsWith("R4"))),
      detail: `${rows.length} requests`,
    },
    {
      name:
        "L2 a bearer revoked by POST /v1/auth/logout is refused by every request issued after the 204",
      holds: postLogoutSuccess === 0,
      detail: `${postLogoutSuccess}/${postLogoutChecked} post-logout 200s`,
    },
    {
      name:
        "L3 a stranger's logout/refresh never disturbs another user's requests",
      holds: !broken.some((r) =>
        r.violations.some((v) => v.includes("stranger"))
      ),
      detail: `${
        rows.filter((r) => r.action.endsWith("other-user")).length
      } other-user requests`,
    },
    {
      name:
        "L4 wall-clock steps of ±120s under a live burst keep Retry-After ≥ 1 and durationMs ≥ 0",
      holds: retryAfterBad === 0 &&
        !broken.some((r) => r.violations.some((v) => v.includes("durationMs"))),
      detail: `${retryAfterBad} bad Retry-After; ${
        rows.filter((r) => r.action.includes("skew")).length
      } skewed lanes`,
    },
    {
      name: "R1–R3 per request",
      holds: !broken.some((r) => r.violations.some((v) => /^R[123]/.test(v))),
      detail: `${broken.length} broken`,
    },
    {
      name: "R5 bounded wall time per burst",
      holds: maxWall < wallBudgetMs(STRESS_BURST),
      detail: `max ${maxWall}ms < ${wallBudgetMs(STRESS_BURST)}ms`,
    },
  );
  printInvariants(scenario, invariants);
  const report = finishReport({
    scenario,
    file: FILE,
    label: "rotation/logout during request + clock skew",
    baseSeed: STRESS_SEED,
    scale: SCALE,
    rows,
    invariants,
    observations: {
      refresh200,
      refreshOther,
      postLogoutChecked,
      brokenSample: broken.slice(0, 10),
    },
    durationMs: Math.round(performance.now() - t0),
    heap: { before: heapBefore, after: Deno.memoryUsage() },
    replay,
  });
  console.log(
    `[stress] wrote ${await writeReport(
      report,
    )} (${report.executed} requests, ${report.broken} broken)`,
  );
  for (const inv of invariants) assert(inv.holds, `${inv.name}: ${inv.detail}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// S5 — size-cap parity: every sanitizeUserText call site vs the column CHECK
// it lands in. The edge cap must be ≤ the DB cap, otherwise a client string
// the edge accepted turns into a 23514 → 503 instead of a 400.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress-edge-http S5: sanitizeUserText caps never exceed the column CHECK they land in (edge 400 before DB 23514)", async () => {
  const h = await loadStressHarness();
  const scenario = "s5-size-cap-parity";
  const rows: OutcomeRow[] = [];
  const invariants: Invariant[] = [];
  const heapBefore = Deno.memoryUsage();
  const t0 = performance.now();
  const replay: Record<string, string> = {};
  const overCap: Record<string, number> = {};
  let handlerForwardedOverCap = 0;
  let handlerChecked = 0;

  for (const round of rounds()) {
    const seed = roundSeed(round);
    replay[String(round)] = replayCommand(FILE, "S5", round);
    const prng = new Prng(seed ^ 0x5555);
    for (let lane = 0; lane < STRESS_BURST; lane++) {
      const site = CAP_SITES[prng.int(0, CAP_SITES.length - 1)];
      const input = longRun(prng, site.edgeCap - 3, site.edgeCap + 40);
      const out = sanitizeUserText(input, site.edgeCap);
      // what reaches the column: the route-level UTF-16 check (if any) rejects first
      const reachesDb = site.routeCap === null || out.length <= site.routeCap;
      const chars = Array.from(out).length; // Postgres length() counts characters
      const v: string[] = [];
      if (reachesDb && chars > site.dbCap) {
        v.push(
          `edge accepted ${chars} chars, column CHECK allows ${site.dbCap} → 23514 → 503`,
        );
        overCap[site.site] = (overCap[site.site] ?? 0) + 1;
      }
      rows.push({
        scenario,
        round,
        seed,
        lane,
        action: site.site,
        status: null,
        ms: 0,
        outcome: v.length ? "BROKEN" : "HELD",
        violations: v,
        note: `sanitized=${chars}cp reachesDb=${reachesDb}`,
      });
    }
  }

  // End to end through the REAL handler: a 64-char consentVersion is accepted
  // by grantConsent and forwarded to PostgREST as-is (the modelled ledger
  // records what would hit the column).
  const restore = captureAccessLog(() => undefined);
  try {
    h.fake.reset(roundSeed(0), 0);
    h.resetLayer();
    const setup = new Prng(STRESS_SEED ^ 0x5e5e);
    const user = await seedUser(h, setup, "s5");
    for (const len of [50, 51, 64]) {
      const version = "v".repeat(len);
      const res = await h.handler(
        edgeRequest("POST", "/v1/me/consent/grant", {
          ip: ip(setup),
          token: user.accessToken,
          body: {
            scope: "model_training",
            consentVersion: version,
            captureMode: "c".repeat(len),
          },
        }),
      );
      await res.body?.cancel();
      handlerChecked += 1;
      const stored = h.consentRecords.at(-1);
      const forwarded = stored?.consent_version ?? "";
      if (res.status === 200 && Array.from(forwarded).length > 50) {
        handlerForwardedOverCap += 1;
      }
      rows.push({
        scenario,
        round: -1,
        seed: STRESS_SEED,
        lane: len,
        action: `handler:consent_version:${len}`,
        status: res.status,
        requestId: res.headers.get("x-request-id"),
        ms: 0,
        outcome: len > 50 && res.status === 200 ? "BROKEN" : "HELD",
        violations: len > 50 && res.status === 200
          ? [
            `POST /v1/me/consent/grant accepted a ${len}-char consentVersion; consent_records.consent_version CHECK is ≤ 50 → real Postgres answers 23514 and the route maps it to 503`,
          ]
          : [],
      });
    }
  } finally {
    restore();
  }

  const broken = rows.filter((r) => r.outcome === "BROKEN");
  invariants.push(
    ...CAP_SITES.map((s) => ({
      name: `C ${s.site}: edge cap ${s.edgeCap}${
        s.routeCap !== null ? ` (route ≤ ${s.routeCap} UTF-16)` : ""
      } ≤ column CHECK ${s.dbCap}`,
      holds: (overCap[s.site] ?? 0) === 0,
      detail: `${rows.filter((r) => r.action === s.site).length} strings, ${
        overCap[s.site] ?? 0
      } over the column cap`,
    })),
    {
      name:
        "C-e2e POST /v1/me/consent/grant refuses (400) any consentVersion the column would refuse",
      holds: handlerForwardedOverCap === 0,
      detail:
        `${handlerForwardedOverCap}/${handlerChecked} over-cap versions forwarded to PostgREST as 200-path inserts`,
    },
  );
  printInvariants(scenario, invariants);
  const report = finishReport({
    scenario,
    file: FILE,
    label: "sanitize cap vs column CHECK parity",
    baseSeed: STRESS_SEED,
    scale: SCALE,
    rows,
    invariants,
    observations: { overCap, brokenSample: broken.slice(0, 10) },
    durationMs: Math.round(performance.now() - t0),
    heap: { before: heapBefore, after: Deno.memoryUsage() },
    replay,
  });
  console.log(
    `[stress] wrote ${await writeReport(
      report,
    )} (${report.executed} lanes, ${report.broken} broken)`,
  );
  for (const inv of invariants) assert(inv.holds, `${inv.name}: ${inv.detail}`);
});
