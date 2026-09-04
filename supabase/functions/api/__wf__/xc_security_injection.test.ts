// Cross-cutting security matrix — injection & sanitization, in-process.
//
// Real edge function (index.ts on :8000) + fake Supabase (edgeHarness.ts).
// Every scenario records the exact payload, the HTTP outcome, what reached
// PostgREST, and every log line the function emitted, so a failure is
// replayable from the artifact alone. Runs with `deno task test`; set
// XC_SEC_ARTIFACT_DIR to also write the raw tables to disk, XC_SEC_SEED to
// replay a seeded batch, XC_SEC_STRICT=1 to turn the recorded contract
// observations into hard assertions (see xcSecurityHarness.ts).
//
//   XC_SEC_ARTIFACT_DIR=$PWD/artifacts/xc-security-injection/inproc \
//     deno test -A --no-check --config supabase/functions/api/__wf__/deno.json \
//     supabase/functions/api/__wf__/xc_security_injection.test.ts
//
// Coverage: shot-sync jsonb payloads (type confusion, SQL/JSON metacharacters,
// prototype-pollution keys, seeded hostile batches at the 200-entry cap),
// free-text sanitization (onboarding, consent, deletion survey, feedback),
// request-id / forwarded-ip / origin / host header injection (fetch + raw
// TCP), log injection (console + access log canary search), drill slug / path
// traversal, SSRF (outbound fetch tap: RevenueCat + Apple token exchange), and
// a prototype snapshot across the whole run.

import { assert, assertEquals } from "@std/assert";
import {
  API_BASE,
  bootEdgeFunction,
  fakeGoogleIdToken,
  recorded,
  resetRest,
  restJson,
  setRestResponder,
  USER_ID,
} from "./edgeHarness.ts";
import {
  advanceClock,
  CANARY_PREFIX,
  canariesIn,
  classifyCanaries,
  clockOffset,
  DATE_STRINGS,
  expectContract,
  hasForbiddenChars,
  heap,
  installDefaultResponder,
  jsonInit,
  mulberry32,
  observations,
  outbound,
  pick,
  PROTO_KEYS,
  protoDiff,
  protoSnapshot,
  rawHttp,
  recordedSince,
  rpcBodies,
  safeJson,
  send,
  sendPublic,
  serializeRecorded,
  SQL_META_STRINGS,
  STRICT,
  tapLogs,
  tapOutboundFetch,
  validShot,
  VERSION_VECTOR,
  writeArtifact,
} from "./xcSecurityHarness.ts";

tapOutboundFetch();
const protoBefore = protoSnapshot();
const summary: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  strict: STRICT,
  heapAtStart: heap(),
};
const SEED = Number(Deno.env.get("XC_SEC_SEED") ?? "20260904");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SHOT_KEYS = [
  "id",
  "analysisPermitId",
  "sessionId",
  "shotType",
  "cameraView",
  "capturedAt",
  "startMs",
  "contactMs",
  "endMs",
  "overallScore",
  "confidence",
  "resultKind",
  "phases",
  "checkpoints",
  "versionVector",
].sort();
const PHASE_KEYS = ["key", "startMs", "representativeMs", "endMs", "confidence"].sort();
const CHECKPOINT_KEYS = [
  "key",
  "score",
  "confidence",
  "band",
  "direction",
  "severity",
  "applicable",
].sort();

interface ShotCase {
  id: string;
  group: string;
  field: string;
  value: unknown;
  describe: string;
}

const phase = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  startMs: 0,
  representativeMs: 1,
  endMs: 2,
  confidence: 0.5,
  ...extra,
});
const checkpoint = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  score: 50,
  confidence: 0.5,
  band: "green",
  direction: "ok",
  severity: 0.1,
  applicable: true,
  ...extra,
});

function shotCases(): ShotCase[] {
  const cases: ShotCase[] = [];
  let n = 0;
  const add = (group: string, field: string, value: unknown, describe = "") => {
    cases.push({ id: `S${String(++n).padStart(3, "0")}`, group, field, value, describe });
  };
  const typeConfusion: unknown[] = [
    null,
    undefined,
    true,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER,
    "",
    [],
    [1],
    {},
    { $ne: null },
    { toString: "x" },
  ];
  for (const field of [
    "id",
    "analysisPermitId",
    "sessionId",
    "shotType",
    "cameraView",
    "capturedAt",
  ]) {
    for (const v of typeConfusion) add("type_confusion", field, v);
  }
  for (const v of typeConfusion) add("type_confusion", "timestamps", v);
  for (const field of ["startMs", "contactMs", "endMs"]) {
    for (const v of [
      -1,
      0.5,
      2 ** 31 - 1,
      2 ** 31,
      2 ** 53,
      "100",
      null,
      "",
      [],
      {},
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      add(
        "numeric_bounds",
        "timestamps",
        { startMs: 0, contactMs: 100, endMs: 200, [field]: v },
        `timestamps.${field}=${String(v)}`,
      );
    }
  }
  add("numeric_bounds", "timestamps", { startMs: 200, contactMs: 100, endMs: 0 }, "reversed order");
  add(
    "numeric_bounds",
    "timestamps",
    { startMs: 0, contactMs: 100, endMs: 200, extra: "x" },
    "extra key",
  );
  for (const k of PROTO_KEYS)
    add(
      "proto",
      `${k}@timestamps`,
      { startMs: 0, contactMs: 100, endMs: 200, [k]: { polluted: true } },
      "extra key in timestamps",
    );
  for (const v of [
    -0.01,
    10.01,
    10.001,
    9.999,
    "7",
    null,
    [],
    {},
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    add("numeric_bounds", "overallScore", v);
  }
  for (const v of [-0.0001, 1.0000001, 0.99999, "0.5", null, Number.NaN])
    add("numeric_bounds", "confidence", v);
  for (const v of [
    "scored",
    "low_confidence",
    "SCORED",
    "",
    null,
    1,
    "scored\u0000",
    "constructor",
  ]) {
    add("enum_bounds", "resultKind", v);
  }
  for (const s of SQL_META_STRINGS) add("sql_meta", "shotType", s);
  for (const s of SQL_META_STRINGS) add("sql_meta", "cameraView", s);
  for (const s of DATE_STRINGS) add("date_strings", "capturedAt", s);
  add("shape", "phases", null);
  add("shape", "phases", {});
  add("shape", "phases", "ready");
  add("shape", "phases", [null]);
  add("shape", "phases", [[]]);
  add("shape", "phases", [{ key: "ready" }]);
  add(
    "shape",
    "phases",
    Array.from({ length: 32 }, (_, i) => phase(`p${i}`)),
    "32 distinct keys (cap)",
  );
  add(
    "shape",
    "phases",
    Array.from({ length: 33 }, (_, i) => phase(`p${i}`)),
    "33 distinct keys (over cap)",
  );
  add("shape", "phases", [phase("ready"), phase("ready")], "duplicate phase key");
  for (const s of SQL_META_STRINGS) add("sql_meta", "phases", [phase(s)], "phase key");
  add("shape", "checkpoints", null);
  add("shape", "checkpoints", {});
  add("shape", "checkpoints", [null]);
  add("shape", "checkpoints", [{ key: "x" }]);
  add(
    "shape",
    "checkpoints",
    Array.from({ length: 64 }, (_, i) => checkpoint(`c${i}`)),
    "64 (cap)",
  );
  add(
    "shape",
    "checkpoints",
    Array.from({ length: 65 }, (_, i) => checkpoint(`c${i}`)),
    "65 (over cap)",
  );
  for (const s of SQL_META_STRINGS)
    add("sql_meta", "checkpoints", [checkpoint(s, { direction: s })], "checkpoint key+direction");
  for (const v of [-1, 101, 100.5, "50", null, Number.NaN]) {
    add("numeric_bounds", "checkpoints", [checkpoint("x", { score: v })], `score=${String(v)}`);
  }
  for (const v of ["purple", "GREEN", "", null, 1, "green\u0000"]) {
    add("enum_bounds", "checkpoints", [checkpoint("x", { band: v })], `band=${String(v)}`);
  }
  add("shape", "versionVector", null);
  add("shape", "versionVector", []);
  add("shape", "versionVector", "1.0.0");
  add("shape", "versionVector", { ...VERSION_VECTOR, appVersion: 1 }, "numeric appVersion");
  add("shape", "versionVector", { ...VERSION_VECTOR, appVersion: "" }, "empty appVersion");
  add(
    "shape",
    "versionVector",
    { ...VERSION_VECTOR, appVersion: "x".repeat(65) },
    "65-char appVersion",
  );
  add(
    "shape",
    "versionVector",
    { ...VERSION_VECTOR, appVersion: "x".repeat(64) },
    "64-char appVersion",
  );
  add(
    "shape",
    "versionVector",
    { ...VERSION_VECTOR, appVersion: "x".repeat(10_000) },
    "10k appVersion",
  );
  add("shape", "versionVector", { ...VERSION_VECTOR, extra: "x" }, "extra key");
  const { appVersion: _drop, ...missing } = VERSION_VECTOR;
  add("shape", "versionVector", missing, "missing appVersion");
  for (const s of SQL_META_STRINGS)
    add("sql_meta", "versionVector", { ...VERSION_VECTOR, appVersion: s }, "appVersion");
  for (const k of PROTO_KEYS) {
    add("proto", `${k}@shot`, { [k]: { polluted: true } }, "extra top-level key on shot");
    add(
      "proto",
      `${k}@versionVector`,
      { ...VERSION_VECTOR, [k]: { polluted: true } },
      "extra key in versionVector",
    );
    add("proto", `${k}@phase`, [phase("ready", { [k]: { polluted: true } })], "extra key in phase");
    add(
      "proto",
      `${k}@checkpoint`,
      [checkpoint("x", { [k]: { polluted: true } })],
      "extra key in checkpoint",
    );
    add("proto", `${k}@phaseKey`, [phase(k)], "phase key IS the proto key");
    add("proto", `${k}@checkpointKey`, [checkpoint(k)], "checkpoint key IS the proto key");
    add("proto", `${k}@shotType`, k, "shotType IS the proto key");
  }
  add("source", "source", "fixture");
  add("source", "source", "REAL");
  add("source", "source", null);
  add("source", "source", undefined);
  add("extra", "__unknown__", "x", "unknown extra key on shot");
  return cases;
}

/** Applies a case to a valid shot. Field names of the form `k@where` place the
 * value structurally; a plain field name replaces that field. */
function buildShot(c: ShotCase): Record<string, unknown> {
  const base = validShot();
  if (c.group === "proto") {
    const [k, where] = c.field.split("@");
    if (where === "shot") return { ...base, [k]: (c.value as Record<string, unknown>)[k] };
    if (where === "versionVector") return { ...base, versionVector: c.value };
    if (where === "phase" || where === "phaseKey") return { ...base, phases: c.value };
    if (where === "checkpoint" || where === "checkpointKey")
      return { ...base, checkpoints: c.value };
    if (where === "shotType") return { ...base, shotType: c.value };
    if (where === "timestamps") return { ...base, timestamps: c.value };
  }
  if (c.field === "__unknown__") return { ...base, xcsecExtra: c.value };
  if (c.value === undefined) {
    const copy: Record<string, unknown> = { ...base };
    delete copy[c.field];
    return copy;
  }
  return { ...base, [c.field]: c.value };
}

/** Wire body for a batch. Objects built with a computed `["__proto__"]` key
 * carry it as an own property, so JSON.stringify emits it verbatim. */
function bodyWithShots(shots: Record<string, unknown>[]): string {
  return JSON.stringify({ shots });
}

/** One valid shot plus an ASCII `pad` member sized so the whole body is
 * exactly `bytes` long (ASCII => bytes === chars). */
function paddedBody(bytes: number): string {
  const head = `{"shots":[${JSON.stringify(validShot())}],"pad":"`;
  const tail = '"}';
  const padLen = bytes - head.length - tail.length;
  if (padLen < 0) throw new Error(`paddedBody: ${bytes} is smaller than the envelope`);
  return `${head}${"p".repeat(padLen)}${tail}`;
}

interface Verdict {
  accepted: boolean;
  rejectedCode: string | null;
  rejectedId: unknown;
}

/** Maps a batch response back onto its inputs. Both `acceptedIds` and
 * `rejected` preserve input order, so walk the inputs and consume. */
function verdictsFor(shots: Record<string, unknown>[], body: unknown): Verdict[] {
  const parsed = body as {
    acceptedIds?: string[];
    rejected?: Array<{ id: unknown; code: string }>;
  } | null;
  const accepted = new Set(parsed?.acceptedIds ?? []);
  const rejected = [...(parsed?.rejected ?? [])];
  return shots.map((shot) => {
    const id = shot.id;
    if (typeof id === "string" && accepted.has(id)) {
      accepted.delete(id);
      return { accepted: true, rejectedCode: null, rejectedId: id };
    }
    const r = rejected.shift();
    return { accepted: false, rejectedCode: r?.code ?? null, rejectedId: r?.id ?? null };
  });
}

function rpcKeyViolation(rpc: Record<string, unknown>): string | null {
  const forwarded = rpc.shot as Record<string, unknown> | undefined;
  if (!forwarded) return "no shot object";
  const keys = Object.keys(forwarded).sort();
  if (keys.join(",") !== SHOT_KEYS.join(",")) return `shot keys ${keys.join(",")}`;
  const vv = forwarded.versionVector as Record<string, unknown>;
  if (Object.keys(vv).sort().join(",") !== Object.keys(VERSION_VECTOR).sort().join(",")) {
    return `versionVector keys ${Object.keys(vv).join(",")}`;
  }
  for (const p of forwarded.phases as Record<string, unknown>[]) {
    if (Object.keys(p).sort().join(",") !== PHASE_KEYS.join(","))
      return `phase keys ${Object.keys(p).join(",")}`;
  }
  for (const cp of forwarded.checkpoints as Record<string, unknown>[]) {
    if (Object.keys(cp).sort().join(",") !== CHECKPOINT_KEYS.join(","))
      return `checkpoint keys ${Object.keys(cp).join(",")}`;
  }
  if (JSON.stringify(rpc).includes("polluted")) return "polluted marker forwarded";
  return null;
}

Deno.test(
  "xcsec: shot-sync jsonb payload matrix (type confusion, SQL/JSON metachars, proto keys)",
  async () => {
    await bootEdgeFunction();
    resetRest();
    installDefaultResponder();
    const tap = tapLogs();
    const cases = shotCases();
    const rows: Record<string, unknown>[] = [];
    const requests: Record<string, unknown>[] = [];
    let unexpected500 = 0;
    let leakedKeys = 0;
    try {
      // Batches of 200 — the route's cap — so one hostile entry sits next to
      // 199 others and any cross-entry poisoning would show up as a wrong
      // verdict count.
      for (let start = 0; start < cases.length; start += 200) {
        const slice = cases.slice(start, start + 200);
        const shots = slice.map(buildShot);
        advanceClock();
        const mark = recorded.length;
        const out = await send("POST", "/v1/shots:sync", {
          headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7" },
          body: bodyWithShots(shots),
        });
        const reached = recordedSince(mark);
        const rpcs = rpcBodies(reached, "apply_synced_shot");
        const verdicts = verdictsFor(shots, out.body);
        const forwardedById = new Map<string, Record<string, unknown>>();
        for (const rpc of rpcs) {
          const id = (rpc.shot as Record<string, unknown> | undefined)?.id;
          if (typeof id === "string") forwardedById.set(id, rpc);
        }
        if (out.status >= 500) unexpected500 += 1;
        requests.push({
          batch: start / 200,
          cases: slice.map((c) => c.id),
          status: out.status,
          ms: out.ms,
          bodyBytes: bodyWithShots(shots).length,
          accepted: verdicts.filter((v) => v.accepted).length,
          rejected: verdicts.filter((v) => !v.accepted).length,
          rpcCalls: rpcs.length,
          responsePreview: out.text.slice(0, 600),
        });
        slice.forEach((c, i) => {
          const shot = shots[i];
          const v = verdicts[i];
          const rpc = typeof shot.id === "string" ? forwardedById.get(shot.id) : undefined;
          const violation = rpc ? rpcKeyViolation(rpc) : null;
          if (violation) leakedKeys += 1;
          rows.push({
            case: c.id,
            group: c.group,
            field: c.field,
            describe: c.describe,
            value: c.value === undefined ? "<undefined:key removed>" : c.value,
            shotId: shot.id,
            httpStatus: out.status,
            accepted: v.accepted,
            rejectedCode: v.rejectedCode,
            rejectedIdEchoed: v.rejectedId,
            reachedRpc: rpc !== undefined,
            rpcKeyViolation: violation,
            forwardedShot: rpc?.shot ?? null,
          });
        });
      }
    } finally {
      tap.stop();
    }
    const canaries = classifyCanaries(tap);
    const artifact = await writeArtifact("shot_sync_matrix.json", {
      seed: SEED,
      cases: rows.length,
      requests,
      unexpected500,
      leakedKeys,
      rows,
      console: tap.console,
      accessLog: tap.access.map((l) => JSON.parse(l)),
      canaries,
    });
    summary.shotMatrix = {
      cases: rows.length,
      requests: requests.length,
      unexpected500,
      leakedKeys,
      canaries: countCanaries(canaries),
      artifact,
    };
    assertEquals(unexpected500, 0, "no payload may 5xx the route");
    assertEquals(leakedKeys, 0, "no attacker-supplied key may reach the RPC");
    assertEquals(canaries.console, [], "no user-controlled canary may reach console logs");
    assertEquals(canaries.accessOther, [], "no user-controlled canary may reach access-log fields");
    for (const r of requests) assertEquals(r.status, 200, `batch ${r.batch} → ${r.status}`);
    for (const r of rows) {
      // exactly one verdict per entry
      assert(
        r.accepted !== (r.rejectedCode !== null),
        `${r.case} needs exactly one verdict: ${safeJson(r)}`,
      );
      // rejected id echo must be the raw string id or null — never an object
      assert(
        r.rejectedIdEchoed === null || typeof r.rejectedIdEchoed === "string",
        `${r.case} echoed a non-string id`,
      );
      // a proto-key or unknown-key case must never be accepted with the key intact (checked via rpcKeyViolation)
      if (r.group === "proto" || r.group === "extra")
        assertEquals(r.rpcKeyViolation, null, r.case as string);
    }
    // Entries that MUST be rejected at the edge (documented contract): every
    // type-confused required field except `sessionId: null`, which is legal.
    const mustReject = rows.filter(
      (r) => r.group === "type_confusion" && !(r.field === "sessionId" && r.value === null),
    );
    for (const r of mustReject)
      assertEquals(r.accepted, false, `${r.case} ${r.field}=${safeJson(r.value)} must be rejected`);
    // Well-formed control cases must be accepted and forwarded with the
    // canonical key set (proves the batch was not poisoned by its neighbours).
    const controls = rows.filter(
      (r) => r.group === "type_confusion" && r.field === "sessionId" && r.value === null,
    );
    assert(controls.length > 0);
    for (const r of controls)
      assertEquals(r.accepted, true, `${r.case} control shot must be accepted`);
    const accepted = rows.filter((r) => r.accepted);
    assert(
      accepted.length > 0,
      "matrix must contain accepted entries for the forwarding check to mean anything",
    );
    for (const r of accepted) assertEquals(r.reachedRpc, true, `${r.case} accepted without an RPC`);
    for (const r of rows.filter(
      (r) => r.group === "source" && r.value !== "<undefined:key removed>",
    )) {
      assertEquals(r.accepted, false, `${r.case} source=${safeJson(r.value)} must be rejected`);
    }
    // Date strings the edge accepts (Date.parse) but Postgres does not are the
    // contract seam exercised live in xc_security_pg_bridge_test.ts.
    const acceptedDates = rows
      .filter((r) => r.group === "date_strings" && r.accepted)
      .map((r) => r.value);
    summary.shotMatrixAcceptedDateStrings = acceptedDates;
  },
);

Deno.test(
  "xcsec: shot-sync body/batch boundaries (0, 1, 200, 201, non-array, proto root keys)",
  async () => {
    await bootEdgeFunction();
    resetRest();
    installDefaultResponder();
    const rows: Record<string, unknown>[] = [];
    const cases: Array<{ name: string; body: string; chunked?: boolean }> = [
      { name: "shots: []", body: JSON.stringify({ shots: [] }) },
      { name: "shots: 1 valid", body: bodyWithShots([validShot()]) },
      {
        name: "shots: 200 valid",
        body: bodyWithShots(Array.from({ length: 200 }, () => validShot())),
      },
      {
        name: "shots: 201 valid",
        body: bodyWithShots(Array.from({ length: 201 }, () => validShot())),
      },
      { name: "shots: {}", body: JSON.stringify({ shots: {} }) },
      { name: "shots: string", body: JSON.stringify({ shots: "x" }) },
      { name: "root array", body: JSON.stringify([validShot()]) },
      { name: "root string", body: JSON.stringify("x") },
      { name: "root null", body: "null" },
      { name: "malformed json", body: '{"shots": [' },
      { name: "empty body", body: "" },
      {
        name: "root __proto__",
        body: `{"__proto__":{"polluted":true},"shots":[${JSON.stringify(validShot())}]}`,
      },
      {
        name: "root constructor.prototype",
        body: `{"constructor":{"prototype":{"polluted":true}},"shots":[${JSON.stringify(validShot())}]}`,
      },
      { name: "shots with __proto__ entry", body: `{"shots":[{"__proto__":{"polluted":true}}]}` },
      {
        name: "duplicate shots key (last wins)",
        body: `{"shots":"x","shots":[${JSON.stringify(validShot())}]}`,
      },
      { name: "deep nesting 5000", body: `{"shots":[${"[".repeat(5000)}${"]".repeat(5000)}]}` },
      {
        name: "200 shots × (32 phases + 64 checkpoints)",
        body: bodyWithShots(
          Array.from({ length: 200 }, () =>
            validShot({
              phases: Array.from({ length: 32 }, (_, i) => phase(`p${i}`)),
              checkpoints: Array.from({ length: 64 }, (_, i) => checkpoint(`c${i}`)),
            }),
          ),
        ),
      },
      {
        name: "200 shots × 64 checkpoints with 4k keys",
        body: bodyWithShots(
          Array.from({ length: 200 }, () =>
            validShot({
              checkpoints: Array.from({ length: 64 }, (_, i) =>
                checkpoint(`c${i}${"k".repeat(4000)}`),
              ),
            }),
          ),
        ),
      },
      { name: "body exactly 5,000,000 bytes", body: paddedBody(5_000_000) },
      { name: "body exactly 5,000,001 bytes", body: paddedBody(5_000_001) },
      {
        name: "body 5,000,001 bytes, chunked (no content-length)",
        body: paddedBody(5_000_001),
        chunked: true,
      },
    ];
    for (const c of cases) {
      advanceClock();
      const mark = recorded.length;
      const before = heap();
      const out = await send("POST", "/v1/shots:sync", {
        headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.8" },
        // A streamed body carries no content-length, so the early header check
        // cannot fire and the byte-counting reader has to enforce the cap.
        body: c.chunked ? new Blob([c.body]).stream() : c.body,
      });
      const after = heap();
      const reached = recordedSince(mark);
      const body = out.body as {
        acceptedIds?: string[];
        rejected?: Array<{ code: string }>;
        code?: string;
      } | null;
      rows.push({
        name: c.name,
        bodyBytes: new TextEncoder().encode(c.body).byteLength,
        chunked: c.chunked ?? false,
        status: out.status,
        ms: out.ms,
        code: body?.code ?? null,
        accepted: body?.acceptedIds?.length ?? null,
        rejected: body?.rejected?.length ?? null,
        rejectedCodes: [...new Set((body?.rejected ?? []).map((r) => r.code))],
        rpcCalls: reached.filter((r) => r.path === "rpc/apply_synced_shot").length,
        heapUsedDelta: after.heapUsed - before.heapUsed,
        rssAfter: after.rss,
        responsePreview: out.text.slice(0, 300),
      });
    }
    const artifact = await writeArtifact("shot_sync_boundaries.json", {
      rows,
      protoDiff: protoDiff(protoBefore, protoSnapshot()),
    });
    summary.shotBoundaries = { cases: rows.length, artifact };
    for (const r of rows) assert((r.status as number) < 500, `${r.name} → ${r.status}`);
    const byName = (name: string) => rows.find((r) => r.name === name)!;
    assertEquals(byName("shots: 1 valid").accepted, 1);
    assertEquals(byName("shots: 200 valid").status, 200);
    assertEquals(byName("shots: 200 valid").rpcCalls, 200);
    assertEquals(byName("shots: 200 valid").accepted, 200);
    assertEquals(byName("200 shots × (32 phases + 64 checkpoints)").accepted, 200);
    assertEquals(byName("shots: 201 valid").status, 400);
    assertEquals(byName("shots: 201 valid").rpcCalls, 0);
    assertEquals(byName("shots: []").status, 400);
    assertEquals(byName("root __proto__").status, 200);
    assertEquals(byName("root __proto__").accepted, 1);
    assertEquals(byName("shots with __proto__ entry").rejected, 1);
    assertEquals(byName("deep nesting 5000").status, 200);
    assertEquals(byName("deep nesting 5000").rejected, 1);
    assertEquals(byName("body exactly 5,000,000 bytes").bodyBytes, 5_000_000);
    assertEquals(byName("body exactly 5,000,000 bytes").status, 200);
    assertEquals(byName("body exactly 5,000,000 bytes").accepted, 1);
    assertEquals(byName("body exactly 5,000,001 bytes").bodyBytes, 5_000_001);
    assertEquals(byName("body exactly 5,000,001 bytes").status, 413);
    assertEquals(byName("body exactly 5,000,001 bytes").rpcCalls, 0);
    assertEquals(byName("body 5,000,001 bytes, chunked (no content-length)").status, 413);
    assertEquals(byName("body 5,000,001 bytes, chunked (no content-length)").rpcCalls, 0);
    assertEquals(protoDiff(protoBefore, protoSnapshot()), []);
  },
);

// ─── log injection through the RPC status string ────────────────────────────
//
// Chain (each link executed, none inferred):
//   1. the route's capturedAt gate is `!Number.isNaN(Date.parse(v))`; V8's
//      legacy date parser ignores a trailing parenthesised comment, so
//      `Jan 1 2026 (<anything, incl. CR/LF/ESC, 100 KB>)` passes and is
//      forwarded to apply_synced_shot verbatim (asserted here against the
//      fake PostgREST);
//   2. Postgres rejects that text for timestamptz and the RPC's
//      `when others then return 'shot.write_failed:' || sqlerrm` returns the
//      offending literal inside the status (executed by
//      supabase/tests/xc_security/apply_synced_shot_injection.sql, cases
//      "capturedAt: … (XCSEC_CANARY_…)");
//   3. the route logs that status raw: console.error("[api] shot sync write
//      failed:", status) — replayed here by answering the RPC with the exact
//      string Postgres produced.

Deno.test(
  "xcsec: log injection chain — capturedAt comment → RPC sqlerrm echo → console.error",
  async () => {
    await bootEdgeFunction();
    resetRest();
    installDefaultResponder();
    const pgEcho = (value: string) =>
      `shot.write_failed:invalid input syntax for type timestamp with time zone: "${value}"`;
    const payloads: Array<{ name: string; value: string }> = [
      {
        name: "crlf forged access-log line",
        value: `Jan 1 2026 (${CANARY_PREFIX}CRLF\r\n{"evt":"api_request","status":500,"route":"/forged"})`,
      },
      {
        name: "bare lf forged [api] line",
        value: `Jan 1 2026 (${CANARY_PREFIX}LF\n[api] unhandled error (forged): Error)`,
      },
      { name: "ansi escape", value: `Jan 1 2026 (${CANARY_PREFIX}ANSI\u001b[31m\u001b[2J)` },
      { name: "bidi + zero-width", value: `Jan 1 2026 (${CANARY_PREFIX}BIDI\u202e\u200b)` },
      { name: "100k padding", value: `Jan 1 2026 (${"X".repeat(100_000)}${CANARY_PREFIX}100K)` },
      { name: "iso + parenthesised comment", value: `2026-09-04 12:00:00 (${CANARY_PREFIX}PAREN)` },
      { name: "leading comment", value: `(${CANARY_PREFIX}LEAD) Jan 1 2026` },
    ];
    const rows: Record<string, unknown>[] = [];
    for (const p of payloads) {
      advanceClock();
      // link 1: the route accepts the value and forwards it unchanged
      let mark = recorded.length;
      const shot = validShot({ capturedAt: p.value });
      const forwardedRes = await send("POST", "/v1/shots:sync", jsonInit({ shots: [shot] }));
      const forwarded = rpcBodies(recordedSince(mark), "apply_synced_shot");
      const forwardedValue = (forwarded[0]?.shot as Record<string, unknown> | undefined)
        ?.capturedAt;

      // link 3: replay the Postgres-shaped status and watch the function's logs
      installDefaultResponder(pgEcho(p.value));
      const tap = tapLogs();
      mark = recorded.length;
      let echoedRes;
      try {
        echoedRes = await send(
          "POST",
          "/v1/shots:sync",
          jsonInit({ shots: [validShot({ capturedAt: p.value })] }),
        );
      } finally {
        tap.stop();
      }
      resetRest();
      installDefaultResponder();
      const body = echoedRes.body as { rejected?: Array<{ code: string; message: string }> } | null;
      const errorLines = tap.console.filter((l) => l.level === "error");
      const leakedLines = errorLines.filter((l) => l.line.includes(p.value));
      const rawNewline = leakedLines.some((l) => /[\r\n]/.test(l.line.replace(/\n$/, "")));
      // control (Cc) or format (Cf: bidi, zero-width) code points, excluding the
      // line's own trailing newline
      const rawEscape = leakedLines.some((l) => hasForbiddenChars(l.line.replace(/[\r\n\t]/g, "")));
      rows.push({
        name: p.name,
        valueLen: p.value.length,
        valuePreview: p.value.slice(0, 80),
        routeAccepted: forwardedRes.status === 200 && forwarded.length === 1,
        forwardedVerbatim: forwardedValue === p.value,
        clientCode: body?.rejected?.[0]?.code ?? null,
        clientMessageEchoes: (body?.rejected?.[0]?.message ?? "").includes(CANARY_PREFIX),
        responseEchoes: echoedRes.text.includes(CANARY_PREFIX),
        consoleErrorLines: errorLines.length,
        loggedVerbatim: leakedLines.length > 0,
        loggedBytes: leakedLines.reduce((n, l) => n + l.line.length, 0),
        rawNewlineInLog: rawNewline,
        rawControlInLog: rawEscape,
        accessLogCanaries: tap.access.filter((l) => l.includes(CANARY_PREFIX)).length,
      });
    }
    const artifact = await writeArtifact("log_injection_chain.json", {
      rows,
      console: [],
      pgSource: "supabase/tests/xc_security/apply_synced_shot_injection.sql",
    });
    summary.logInjectionChain = { cases: rows.length, artifact };
    for (const r of rows) {
      // hard: the client never sees the detail, the categorical access log stays clean
      assertEquals(r.clientCode, "shot.write_failed", `${r.name}: stable client code`);
      assertEquals(r.clientMessageEchoes, false, `${r.name}: client message must be generic`);
      assertEquals(r.responseEchoes, false, `${r.name}: response must not echo input`);
      assertEquals(r.accessLogCanaries, 0, `${r.name}: access log stays categorical`);
      // links 1 + 3 as executed facts
      assertEquals(r.routeAccepted, true, `${r.name}: route accepts V8-parsable comment date`);
      assertEquals(r.forwardedVerbatim, true, `${r.name}: forwarded to the RPC unchanged`);
      // contract: function logs must not carry attacker-controlled bytes / lines
      expectContract(
        "log_injection",
        r.loggedVerbatim === false,
        "RPC status detail containing client-controlled text must not be written raw to function logs",
        r,
      );
      expectContract(
        "log_injection",
        r.rawNewlineInLog === false && r.rawControlInLog === false,
        "log lines must not contain raw CR/LF/ESC/bidi from client input (forged lines, terminal escapes)",
        r,
      );
      expectContract(
        "log_injection",
        (r.loggedBytes as number) < 4096,
        "capturedAt has no length cap at the route; a 100 KB literal is logged per rejected shot (x200 per request)",
        r,
      );
    }
  },
);

Deno.test(
  "xcsec: seeded hostile shot batches at the 200-entry cap (25 batches = 5000 shots)",
  async () => {
    await bootEdgeFunction();
    resetRest();
    installDefaultResponder();
    const rand = mulberry32(SEED);
    const tap = tapLogs();
    const batches: Record<string, unknown>[] = [];
    const codeHistogram: Record<string, number> = {};
    const failures: Record<string, unknown>[] = [];
    const fields = [
      "id",
      "analysisPermitId",
      "sessionId",
      "shotType",
      "cameraView",
      "capturedAt",
      "timestamps",
      "overallScore",
      "confidence",
      "resultKind",
      "phases",
      "checkpoints",
      "versionVector",
      "source",
    ];
    const hostileValues: unknown[] = [
      ...SQL_META_STRINGS,
      ...DATE_STRINGS,
      null,
      undefined,
      true,
      -1,
      0.5,
      2 ** 31,
      Number.NaN,
      [],
      {},
      [{ ["__proto__"]: { polluted: true } }],
      { constructor: { prototype: { polluted: true } } },
      "x".repeat(70_000),
    ];
    const heapBefore = heap();
    const seedsByBatch: Array<Array<{ index: number; mutations: Array<[string, unknown]> }>> = [];
    try {
      for (let b = 0; b < 25; b += 1) {
        const shots: Record<string, unknown>[] = [];
        const seeds: Array<{ index: number; mutations: Array<[string, unknown]> }> = [];
        for (let i = 0; i < 200; i += 1) {
          const shot = validShot({
            id: `${(b * 200 + i).toString(16).padStart(8, "0")}-0000-4000-8000-${SEED.toString(16).padStart(12, "0")}`,
          });
          const mutations: Array<[string, unknown]> = [];
          const n = Math.floor(rand() * 4); // 0..3 hostile mutations; 0 → valid shot
          for (let m = 0; m < n; m += 1) {
            const f = pick(rand, fields);
            const v = pick(rand, hostileValues);
            mutations.push([f, v === undefined ? "<undefined>" : v]);
            if (v === undefined) delete shot[f];
            else shot[f] = v;
          }
          shots.push(shot);
          seeds.push({ index: i, mutations });
        }
        seedsByBatch.push(seeds);
        advanceClock();
        const mark = recorded.length;
        const bodyText = bodyWithShots(shots);
        const out = await send("POST", "/v1/shots:sync", {
          headers: { "Content-Type": "application/json", "x-forwarded-for": `203.0.113.${10 + b}` },
          body: bodyText,
        });
        const reached = recordedSince(mark);
        const rpcs = rpcBodies(reached, "apply_synced_shot");
        const verdicts = verdictsFor(shots, out.body);
        const accepted = verdicts.filter((v) => v.accepted).length;
        for (const v of verdicts) {
          const k = v.accepted ? "<accepted>" : (v.rejectedCode ?? "<no-code>");
          codeHistogram[k] = (codeHistogram[k] ?? 0) + 1;
        }
        const body = out.body as { acceptedIds?: string[]; rejected?: unknown[] } | null;
        const accounted = (body?.acceptedIds?.length ?? 0) + (body?.rejected?.length ?? 0);
        const violations = rpcs.map(rpcKeyViolation).filter((v): v is string => v !== null);
        // an unmutated shot must be accepted; a shot whose mutation removed or
        // replaced a required field must not be
        const wrongVerdicts: Array<{
          index: number;
          mutations: Array<[string, unknown]>;
          verdict: Verdict;
        }> = [];
        seeds.forEach((s, i) => {
          if (s.mutations.length === 0 && !verdicts[i].accepted)
            wrongVerdicts.push({ ...s, verdict: verdicts[i] });
        });
        const batch = {
          batch: b,
          status: out.status,
          ms: out.ms,
          bodyBytes: bodyText.length,
          accepted,
          rejected: 200 - accepted,
          accounted,
          rpcCalls: rpcs.length,
          rpcKeyViolations: violations,
          wrongVerdicts: wrongVerdicts.length,
          heap: heap(),
        };
        batches.push(batch);
        if (
          out.status !== 200 ||
          accounted !== 200 ||
          rpcs.length !== accepted ||
          violations.length > 0 ||
          wrongVerdicts.length > 0
        ) {
          failures.push({
            ...batch,
            seed: SEED,
            seeds,
            wrongVerdictDetail: wrongVerdicts,
            responseText: out.text.slice(0, 2000),
          });
        }
      }
    } finally {
      tap.stop();
    }
    const canaries = classifyCanaries(tap);
    const artifact = await writeArtifact("shot_sync_seeded_batches.json", {
      seed: SEED,
      replay: `XC_SEC_SEED=${SEED} deno test -A --no-check --config supabase/functions/api/__wf__/deno.json supabase/functions/api/__wf__/xc_security_injection.test.ts --filter seeded`,
      batches,
      codeHistogram,
      heapBefore,
      heapAfter: heap(),
      failures,
      seedsByBatch,
      consoleLines: tap.console.length,
      accessEntries: tap.access.length,
      canaries,
      protoDiff: protoDiff(protoBefore, protoSnapshot()),
    });
    summary.seededBatches = {
      batches: batches.length,
      shots: batches.length * 200,
      codeHistogram,
      failures: failures.length,
      artifact,
    };
    assertEquals(
      failures,
      [],
      "every seeded batch must be a 200 with 200 verdicts, one RPC per accepted shot, and no key leak",
    );
    assertEquals(canaries.console, []);
    assertEquals(canaries.accessOther, []);
    assertEquals(protoDiff(protoBefore, protoSnapshot()), []);
  },
);

// ─── free text ──────────────────────────────────────────────────────────────

const FREE_TEXT_PAYLOADS: Array<{ name: string; value: string }> = [
  {
    name: "bidi+bell+zwsp",
    value: `${CANARY_PREFIX}FT1 I lose dinks\u202e\u0007\u200b at the kitchen`,
  },
  { name: "nul", value: `${CANARY_PREFIX}FT2\u0000drop` },
  { name: "crlf log line", value: `${CANARY_PREFIX}FT3\r\n{"evt":"api_request","status":200}` },
  { name: "ansi", value: `${CANARY_PREFIX}FT4 \x1b[2J\x1b[H` },
  { name: "lone surrogate", value: `${CANARY_PREFIX}FT5 \ud800 x` },
  { name: "zwj emoji", value: `${CANARY_PREFIX}FT6 👨‍👩‍👧‍👦` },
  { name: "combining", value: `${CANARY_PREFIX}FT7 e\u0301\u0301\u0301` },
  { name: "rtl override name", value: `${CANARY_PREFIX}FT8 \u202egnp.exe` },
  { name: "sql", value: `${CANARY_PREFIX}FT9 '); drop table profiles; --` },
  { name: "html", value: `${CANARY_PREFIX}FT10 <script>alert(1)</script>` },
  { name: "10k", value: `${CANARY_PREFIX}FT11 ${"x".repeat(10_000)}` },
  { name: "200 emoji (400 utf16)", value: `${CANARY_PREFIX}FT12 ${"💥".repeat(200)}` },
  { name: "whitespace soup", value: `\t\n  ${CANARY_PREFIX}FT13   \u00a0\u2003 x  ` },
  { name: "only controls", value: "\u0000\u0001\u0002\u001f\u007f" },
  { name: "soft hyphen + word joiner", value: `${CANARY_PREFIX}FT15 a\u00adb\u2060c` },
  { name: "__proto__", value: "__proto__" },
];

function storedStrings(stored: Record<string, unknown> | null): string[] {
  if (!stored) return [];
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(stored);
  return out;
}

Deno.test(
  "xcsec: free-text sanitization matrix (onboarding, consent, deletion survey, feedback)",
  async () => {
    await bootEdgeFunction();
    resetRest();
    installDefaultResponder();
    const tap = tapLogs();
    const rows: Record<string, unknown>[] = [];
    let sent = 0;
    const fresh = () => {
      if (sent++ % 50 === 0) advanceClock();
    };
    try {
      for (const p of FREE_TEXT_PAYLOADS) {
        fresh();
        const mark = recorded.length;
        const out = await send(
          "PUT",
          "/v1/me/onboarding",
          jsonInit(
            {
              skillLevel: p.value,
              goal: "dinks",
              biggestProblem: p.value,
              firstName: p.value,
              gender: "woman",
              handedness: "right",
            },
            { "x-forwarded-for": "203.0.113.50" },
          ),
        );
        const reached = recordedSince(mark);
        const patch = reached.find((r) => r.path === "profiles" && r.method === "PATCH");
        const stored = patch ? (JSON.parse(patch.body) as Record<string, unknown>) : null;
        const strings = storedStrings(stored);
        rows.push({
          route: "PUT /v1/me/onboarding",
          payload: p.name,
          inputCodePoints: [...p.value].length,
          status: out.status,
          code: (out.body as { code?: string } | null)?.code ?? null,
          stored,
          storedHasForbidden: strings.some(hasForbiddenChars),
          storedMaxCodePoints: Math.max(0, ...strings.map((s) => [...s].length)),
        });
      }
      for (const goal of [
        "__proto__",
        "constructor",
        "toString",
        "hasOwnProperty",
        "valueOf",
        "dinks",
        "",
        "x".repeat(300),
      ]) {
        fresh();
        const mark = recorded.length;
        const out = await send(
          "PUT",
          "/v1/me/onboarding",
          jsonInit(
            { skillLevel: "beginner", goal, biggestProblem: "x" },
            { "x-forwarded-for": "203.0.113.51" },
          ),
        );
        const reached = recordedSince(mark);
        const patch = reached.find((r) => r.path === "profiles" && r.method === "PATCH");
        const stored = patch ? (JSON.parse(patch.body) as Record<string, unknown>) : null;
        rows.push({
          route: "PUT /v1/me/onboarding (goal key)",
          payload: goal.length > 40 ? `${goal.slice(0, 40)}…` : goal,
          status: out.status,
          response: out.text.slice(0, 400),
          stored,
          focusCheckpointType: stored ? typeof stored.focus_checkpoint : null,
          focusCheckpointIsFunction: stored ? typeof stored.focus_checkpoint === "function" : null,
        });
      }
      for (const p of FREE_TEXT_PAYLOADS) {
        fresh();
        const mark = recorded.length;
        const out = await send(
          "POST",
          "/v1/consent",
          jsonInit(
            {
              scope: "video_analysis",
              consentVersion: p.value,
              source: p.value,
              device: p.value,
              captureMode: p.value,
            },
            { "x-forwarded-for": "203.0.113.52" },
          ),
        );
        const reached = recordedSince(mark);
        const insert = reached.find((r) => r.path === "consent_records" && r.method === "POST");
        const stored = insert ? (JSON.parse(insert.body) as Record<string, unknown>) : null;
        const strings = storedStrings(stored);
        rows.push({
          route: "POST /v1/consent",
          payload: p.name,
          status: out.status,
          code: (out.body as { code?: string } | null)?.code ?? null,
          stored,
          storedHasForbidden: strings.some(hasForbiddenChars),
          storedMaxCodePoints: Math.max(0, ...strings.map((s) => [...s].length)),
        });
      }
      for (const p of FREE_TEXT_PAYLOADS) {
        fresh();
        const mark = recorded.length;
        const out = await send(
          "POST",
          "/v1/account/delete-request",
          jsonInit(
            {
              survey: {
                reason: "not_useful",
                wanted: "other",
                details: p.value,
                platform: "ios",
                appVersion: p.value,
              },
            },
            { "x-forwarded-for": "203.0.113.53" },
          ),
        );
        const reached = recordedSince(mark);
        const insert = reached.find(
          (r) => r.path === "account_deletion_feedback" && r.method === "POST",
        );
        const stored = insert ? (JSON.parse(insert.body) as Record<string, unknown>) : null;
        const strings = storedStrings(stored);
        rows.push({
          route: "POST /v1/account/delete-request (survey)",
          payload: p.name,
          status: out.status,
          stored,
          storedHasForbidden: strings.some(hasForbiddenChars),
          storedMaxCodePoints: Math.max(0, ...strings.map((s) => [...s].length)),
          postgrestPaths: reached.map((r) => `${r.method} ${r.path}`),
        });
      }
      for (const p of FREE_TEXT_PAYLOADS) {
        fresh();
        const mark = recorded.length;
        const out = await send(
          "POST",
          "/v1/analysis-feedback",
          jsonInit(
            {
              shotId: crypto.randomUUID(),
              rating: "not_quite",
              categories: [p.value, "wrong_stroke"],
              note: p.value,
              comment: p.value,
              details: p.value,
            },
            { "x-forwarded-for": "203.0.113.54" },
          ),
        );
        const reached = recordedSince(mark);
        const insert = reached.find((r) => r.method === "POST" && r.path.includes("feedback"));
        const stored = insert ? (JSON.parse(insert.body) as Record<string, unknown>) : null;
        const strings = storedStrings(stored);
        rows.push({
          route: "POST /v1/analysis-feedback",
          payload: p.name,
          status: out.status,
          code: (out.body as { code?: string } | null)?.code ?? null,
          postgrestPath: insert?.path ?? null,
          stored,
          storedHasForbidden: strings.some(hasForbiddenChars),
          storedRawHasCanary: insert ? canariesIn(insert.body).length > 0 : false,
        });
      }
    } finally {
      tap.stop();
    }
    const canaries = classifyCanaries(tap);
    const artifact = await writeArtifact("free_text_matrix.json", {
      rows,
      console: tap.console,
      accessLog: tap.access.map((l) => JSON.parse(l)),
      canaries,
    });
    summary.freeText = { cases: rows.length, canaries: countCanaries(canaries), artifact };
    assertEquals(canaries.console, [], "free text must never reach console logs");
    assertEquals(canaries.accessOther, [], "free text must never reach access-log fields");
    assertEquals(
      canaries.accessRoute,
      [],
      "free text is body-only; it must not appear in the route",
    );
    for (const r of rows) {
      assert((r.status as number) < 500, `${r.route} ${r.payload} → ${r.status}`);
      if (r.stored !== null && r.storedHasForbidden !== undefined) {
        assertEquals(
          r.storedHasForbidden,
          false,
          `${r.route} ${r.payload} stored control/format/surrogate chars: ${safeJson(r.stored)}`,
        );
      }
      if (r.focusCheckpointIsFunction !== null && r.focusCheckpointIsFunction !== undefined) {
        assertEquals(
          r.focusCheckpointIsFunction,
          false,
          `${r.payload} goal resolved to a prototype member`,
        );
      }
    }
    for (const r of rows.filter((r) => r.route === "PUT /v1/me/onboarding" && r.stored !== null)) {
      assert(
        (r.storedMaxCodePoints as number) <= 1_000,
        `${r.payload} exceeds the onboarding free-text cap`,
      );
    }
  },
);

// ─── headers ────────────────────────────────────────────────────────────────

Deno.test(
  "xcsec: header injection matrix (x-request-id, forwarded-for, origin, host; fetch + raw TCP)",
  async () => {
    await bootEdgeFunction();
    resetRest();
    const tap = tapLogs();
    const rows: Record<string, unknown>[] = [];
    const REQ_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
    const clip = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…(${s.length})` : s);
    try {
      const requestIds = [
        "abcdefgh",
        "abcdefg",
        "a".repeat(64),
        "a".repeat(65),
        "a".repeat(10_000),
        "../../etc/passwd",
        "id with space",
        "id\ttab",
        'id"quote',
        "id;semicolon",
        "id%0d%0aSet-Cookie:%20a=b",
        "id\u00e9unicode",
        "id\u200bzero",
        "XCSEC_CANARY_REQID_ok_1",
        "XCSEC_CANARY_REQID<script>",
        "",
      ];
      let ipN = 100;
      for (const rid of requestIds) {
        let out;
        try {
          out = await sendPublic("GET", "/healthz", {
            headers: { "x-request-id": rid, "x-forwarded-for": `203.0.113.${ipN++}` },
          });
        } catch (error) {
          rows.push({ header: "x-request-id", value: clip(rid), fetchError: String(error) });
          continue;
        }
        const echoed = out.requestId ?? "";
        rows.push({
          header: "x-request-id",
          value: clip(rid),
          status: out.status,
          echoed: clip(echoed),
          echoedIsInput: echoed === rid,
          echoedValid: REQ_ID_RE.test(echoed) || UUID_RE.test(echoed),
        });
      }
      const forwarded = [
        "1.1.1.1, 2.2.2.2",
        "not-an-ip",
        "XCSEC_CANARY_XFF\r\nX-Injected: 1",
        "\u0000",
        "x".repeat(20_000),
        "::1",
        "2001:db8::1, XCSEC_CANARY_XFF2",
        "",
      ];
      for (const xff of forwarded) {
        for (const header of ["x-forwarded-for", "cf-connecting-ip"]) {
          let out;
          try {
            out = await sendPublic("GET", "/healthz", { headers: { [header]: xff } });
          } catch (error) {
            rows.push({ header, value: clip(xff), fetchError: String(error) });
            continue;
          }
          rows.push({ header, value: clip(xff), status: out.status, requestId: out.requestId });
        }
      }
      for (const origin of [
        "https://evil.example",
        "null",
        "XCSEC_CANARY_ORIGIN",
        "https://picklesensei.app\r\nX-Injected: 1",
        "http://127.0.0.1:8000",
      ]) {
        let res: Response;
        try {
          res = await fetch(`${API_BASE}/v1/me`, {
            method: "OPTIONS",
            headers: {
              origin,
              "access-control-request-method": "GET",
              "x-forwarded-for": `203.0.113.${ipN++}`,
            },
          });
        } catch (error) {
          rows.push({ header: "origin(preflight)", value: origin, fetchError: String(error) });
          continue;
        }
        await res.body?.cancel();
        rows.push({
          header: "origin(preflight)",
          value: origin,
          status: res.status,
          allowOrigin: res.headers.get("access-control-allow-origin"),
          allowCredentials: res.headers.get("access-control-allow-credentials"),
          vary: res.headers.get("vary"),
        });
      }
      // Raw TCP: CR/LF and invalid bytes a fetch client would refuse to send.
      const raw: Array<{ name: string; req: string }> = [
        {
          name: "x-request-id followed by injected header line",
          req: "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nx-request-id: abcdefghij\r\nX-Injected: XCSEC_CANARY_RAW1\r\nConnection: close\r\n\r\n",
        },
        {
          name: "x-request-id obs-fold",
          req: "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nx-request-id: abcdefghij\r\n XCSEC_CANARY_RAW2\r\nConnection: close\r\n\r\n",
        },
        {
          name: "x-request-id bare LF",
          req: "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nx-request-id: abcd\nefghij\r\nConnection: close\r\n\r\n",
        },
        {
          name: "x-request-id NUL",
          req: "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nx-request-id: abcd\u0000efghij\r\nConnection: close\r\n\r\n",
        },
        {
          name: "x-request-id 8-bit bytes",
          req: "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nx-request-id: abcd\u00ff\u00feefghij\r\nConnection: close\r\n\r\n",
        },
        {
          name: "hostile Host",
          req: "GET /healthz HTTP/1.1\r\nHost: evil.example:80@127.0.0.1\r\nConnection: close\r\n\r\n",
        },
        {
          name: "absolute-form target",
          req: "GET http://evil.example/healthz HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nConnection: close\r\n\r\n",
        },
        {
          name: "path with raw control",
          req: "GET /v1/drills/catalog/a\u0001b HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nConnection: close\r\n\r\n",
        },
        {
          name: "duplicate content-length",
          req: "POST /v1/shots:sync HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nContent-Length: 2\r\nContent-Length: 20\r\nConnection: close\r\n\r\n{}",
        },
        {
          name: "content-length + transfer-encoding (smuggle probe)",
          req: "POST /v1/shots:sync HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\nGET /healthz HTTP/1.1\r\nHost: x\r\n\r\n",
        },
        {
          name: "x-forwarded-for followed by injected header line",
          req: "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nx-forwarded-for: 1.1.1.1\r\nX-Injected: XCSEC_CANARY_RAW3\r\nConnection: close\r\n\r\n",
        },
        {
          name: "authorization with canary token",
          req: "GET /v1/me HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nAuthorization: Bearer XCSEC_CANARY_RAW4.bad.token\r\nConnection: close\r\n\r\n",
        },
        {
          name: "authorization with 64KiB token",
          req: `GET /v1/me HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nAuthorization: Bearer ${"A".repeat(65_536)}\r\nConnection: close\r\n\r\n`,
        },
      ];
      for (const r of raw) {
        const res = await rawHttp(r.req);
        const xrid = /x-request-id:\s*([^\r\n]*)/i.exec(res.head)?.[1] ?? null;
        const injectedInResponse = /^x-injected:/im.test(res.head);
        rows.push({
          header: `raw:${r.name}`,
          status: res.status,
          requestId: xrid,
          requestIdValid: xrid === null ? null : REQ_ID_RE.test(xrid) || UUID_RE.test(xrid),
          injectedHeaderInResponse: injectedInResponse,
          headBytes: res.head.length,
          error: res.error,
          bodyPreview: res.body.slice(0, 200),
        });
      }
    } finally {
      tap.stop();
    }
    const canaries = classifyCanaries(tap);
    const accessEntries = tap.access.map((l) => JSON.parse(l) as Record<string, unknown>);
    const accessKeys = [...new Set(accessEntries.flatMap((e) => Object.keys(e)))].sort();
    const artifact = await writeArtifact("header_matrix.json", {
      rows,
      accessKeys,
      console: tap.console,
      accessLog: accessEntries,
      canaries,
    });
    summary.headers = {
      cases: rows.length,
      accessKeys,
      canaries: countCanaries(canaries),
      artifact,
    };
    assertEquals(canaries.console, [], "header values must never reach console logs");
    assertEquals(
      canaries.accessOther,
      [],
      "header values must never reach access-log fields other than a filtered requestId",
    );
    // A canary request id that passed the [A-Za-z0-9._-]{8,64} filter IS the
    // documented behavior (bounded, structure-safe); anything else must not echo.
    for (const line of canaries.accessRequestId) {
      const entry = JSON.parse(line) as { requestId: string };
      assert(
        REQ_ID_RE.test(entry.requestId),
        `unfiltered request id reached the access log: ${line}`,
      );
    }
    for (const r of rows) {
      if (r.header === "x-request-id" && r.status !== undefined) {
        assertEquals(r.echoedValid, true, `x-request-id ${String(r.value)} echoed an invalid id`);
        assert((r.status as number) < 500);
      }
      if (typeof r.header === "string" && r.header.startsWith("raw:")) {
        assertEquals(r.injectedHeaderInResponse, false, `${r.header} reflected an injected header`);
        if (r.requestIdValid !== null && r.requestIdValid !== undefined)
          assertEquals(r.requestIdValid, true, `${r.header}`);
        if (r.status !== null) assert((r.status as number) < 500, `${r.header} → ${r.status}`);
      }
      if (
        (r.header === "x-forwarded-for" || r.header === "cf-connecting-ip") &&
        r.status !== undefined
      ) {
        assert((r.status as number) < 500);
      }
    }
    // Access-log entries must be categorical: no IPs, no free text, no bearer.
    const forbidden = [
      "ip",
      "path",
      "query",
      "body",
      "token",
      "userId",
      "user_id",
      "authorization",
      "bearer",
    ];
    for (const line of tap.access) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      for (const k of forbidden)
        assert(!(k in entry), `access log carries a forbidden key ${k}: ${line}`);
      assert(!/203\.0\.113\./.test(line), `access log carries an IP: ${line}`);
      assert(!/Bearer|eyJ/.test(line), `access log carries a token: ${line}`);
    }
  },
);

// ─── path traversal / drill slugs ───────────────────────────────────────────

Deno.test(
  "xcsec: drill slug + path traversal matrix (catalog, saved drills, unknown routes)",
  async () => {
    await bootEdgeFunction();
    resetRest();
    installDefaultResponder();
    const tap = tapLogs();
    const rows: Record<string, unknown>[] = [];
    let sent = 0;
    const fresh = () => {
      if (sent++ % 50 === 0) advanceClock();
    };
    const clip = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…(${s.length})` : s);
    const slugs = [
      "dink-drop-ladder",
      "../../etc/passwd",
      "..%2f..%2fetc%2fpasswd",
      "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "..%252f..%252fetc",
      "....//....//etc/passwd",
      "..\\..\\windows\\system32",
      "%c0%ae%c0%ae/",
      "slug%00.mp4",
      "slug%0d%0aX-Injected:1",
      "slug%ZZ",
      "%",
      "%E0%A4%A",
      "slug'--",
      'slug"or"1"="1',
      "slug,eq.x",
      "slug)or(slug.eq.x",
      "slug*",
      "slug.eq.x",
      "*",
      "-",
      "_",
      "a".repeat(120),
      "a".repeat(121),
      "a".repeat(5000),
      "XCSEC_CANARY_SLUG",
      "https:%2f%2fevil.example%2fx",
      "file:%2f%2f%2fetc%2fpasswd",
      "%2e",
      ".",
      "..",
      "..;%2f",
    ];
    try {
      for (const slug of slugs) {
        fresh();
        const mark1 = recorded.length;
        const cat = await send("GET", `/v1/drills/catalog/${slug}`, {
          headers: { "x-forwarded-for": "203.0.113.70" },
        });
        const catReached = recordedSince(mark1);
        fresh();
        const mark2 = recorded.length;
        const saveOut = await send("POST", `/v1/drills/saved/${slug}`, {
          headers: { "x-forwarded-for": "203.0.113.71" },
        });
        const saveReached = recordedSince(mark2);
        fresh();
        const mark3 = recorded.length;
        const delOut = await send("DELETE", `/v1/drills/saved/${slug}`, {
          headers: { "x-forwarded-for": "203.0.113.72" },
        });
        const delReached = recordedSince(mark3);
        const postgrestPathsOk = [...saveReached, ...delReached].every(
          (r) => r.path === "user_saved_drills",
        );
        const filterValues = [...saveReached, ...delReached].flatMap((r) =>
          [...r.query.entries()].filter(([k]) => k === "drill_slug").map(([, v]) => v),
        );
        rows.push({
          slug: clip(slug),
          catalog: {
            status: cat.status,
            code: (cat.body as { code?: string } | null)?.code ?? null,
            postgrest: catReached.length,
            bodyPreview: cat.text.slice(0, 160),
          },
          save: {
            status: saveOut.status,
            code: (saveOut.body as { code?: string } | null)?.code ?? null,
            postgrest: serializeRecorded(saveReached),
          },
          unsave: {
            status: delOut.status,
            code: (delOut.body as { code?: string } | null)?.code ?? null,
            postgrest: serializeRecorded(delReached),
          },
          postgrestPathsOk,
          drillSlugFilterValues: filterValues,
        });
      }
      for (const q of [
        "dink",
        "(",
        "[",
        "*",
        ".*",
        "(a+)+$",
        "x".repeat(60_000),
        "%00",
        "XCSEC_CANARY_Q",
        "__proto__",
      ]) {
        fresh();
        const out = await send("GET", `/v1/drills/catalog?q=${encodeURIComponent(q)}`, {
          headers: { "x-forwarded-for": "203.0.113.73" },
        });
        rows.push({ search: clip(q), status: out.status, ms: out.ms, bodyBytes: out.text.length });
      }
      for (const path of [
        "/v1/../healthz",
        "/v1/%2e%2e/healthz",
        "/healthz/../v1/me",
        "/v1/me/../../healthz",
        "/v1/XCSEC_CANARY_PATH",
        "/v1/sessions/XCSEC_CANARY_SEG/end",
        "/v1/sessions/00000000-0000-4000-8000-000000000000/end",
        "/v1/sessions/%00/end",
        "/v1/sessions/%ZZ/end",
        "/v1/analysis-permits/XCSEC_CANARY_PERMIT/finalize",
        "/v1/analyses/XCSEC_CANARY_ANALYSIS/feedback",
        "//v1//me",
        "/v1/me%20",
        "/v1/me?XCSEC_CANARY_QUERY=1",
        "/v1/me#XCSEC_CANARY_FRAG",
        "/v1/me/XCSEC_CANARY_TRAIL",
        `/v1/${"x".repeat(8000)}`,
      ]) {
        fresh();
        const out = await send(
          path.includes("finalize") || path.includes("feedback") ? "POST" : "GET",
          path,
          { headers: { "x-forwarded-for": "203.0.113.74" } },
        );
        rows.push({
          path: clip(path),
          status: out.status,
          code: (out.body as { code?: string } | null)?.code ?? null,
          bodyPreview: out.text.slice(0, 200),
        });
      }
    } finally {
      tap.stop();
    }
    const accessEntries = tap.access.map((l) => JSON.parse(l) as Record<string, unknown>);
    const canaries = classifyCanaries(tap);
    const routes = [...new Set(accessEntries.map((e) => String(e.route)))].sort();
    const untemplated = routes.filter(
      (r) => /XCSEC|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(r) || r.length > 120,
    );
    const artifact = await writeArtifact("path_traversal_matrix.json", {
      rows,
      routes,
      untemplatedRoutes: untemplated,
      console: tap.console,
      accessLog: accessEntries,
      canaries,
    });
    summary.paths = {
      cases: rows.length,
      distinctRoutes: routes.length,
      untemplatedRoutes: untemplated,
      canaries: countCanaries(canaries),
      artifact,
    };
    assertEquals(canaries.console, [], "path/slug/query text must never reach console logs");
    assertEquals(
      canaries.accessOther,
      [],
      "path/slug/query text must never reach access-log fields other than route",
    );
    for (const r of rows) {
      if ("catalog" in r) {
        const row = r as {
          catalog: { status: number };
          save: { status: number };
          unsave: { status: number };
          postgrestPathsOk: boolean;
          drillSlugFilterValues: string[];
        };
        assert(
          row.catalog.status < 500 && row.save.status < 500 && row.unsave.status < 500,
          `slug ${String(r.slug)}`,
        );
        assertEquals(
          row.postgrestPathsOk,
          true,
          `slug ${String(r.slug)} changed the PostgREST path`,
        );
        // any slug that reached PostgREST as a filter must be a plain slug
        for (const v of row.drillSlugFilterValues)
          assert(
            /^eq\.[a-z0-9-]{1,120}$/.test(v),
            `unsafe PostgREST filter ${v} for slug ${String(r.slug)}`,
          );
      }
      if ("search" in r || "path" in r) assert((r.status as number) < 500, safeJson(r));
    }
    // Documented contract (REVIEW.md, http.ts): access-log `route` is a
    // template — user-controlled segments must not be reflected verbatim.
    expectContract(
      "paths",
      untemplated.length === 0,
      "access-log route must not reflect non-UUID user path segments verbatim",
      untemplated,
    );
    expectContract(
      "paths",
      canaries.accessRoute.length === 0,
      "user-controlled canary must not reach the access-log route field",
      canaries.accessRoute.slice(0, 5),
    );
  },
);

// ─── SSRF ───────────────────────────────────────────────────────────────────

async function p256Pkcs8Pem(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

function fakeAppleIdToken(sub = "apple-sub-xcsec"): string {
  const enc = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const now = Math.floor(Date.now() / 1000);
  return `${enc({ alg: "RS256", kid: "xcsec" })}.${enc({ iss: "https://appleid.apple.com", aud: "com.picklesensei", sub, iat: now, exp: now + 3600, email: "xcsec@privaterelay.appleid.com" })}.sig`;
}

Deno.test(
  "xcsec: SSRF — every outbound fetch across the run targets an allow-listed origin/path",
  async () => {
    await bootEdgeFunction();
    resetRest();
    installDefaultResponder();
    const tap = tapLogs();
    const rows: Record<string, unknown>[] = [];
    const saved = new Map<string, string | undefined>();
    const setEnv = (k: string, v: string) => {
      saved.set(k, Deno.env.get(k));
      Deno.env.set(k, v);
    };
    setEnv("REVENUECAT_PUBLIC_SDK_KEY", "xcsec-not-a-real-key");
    setEnv("REVENUECAT_WEBHOOK_AUTH", "xcsec-webhook-auth");
    setEnv("SUPABASE_SERVICE_ROLE_KEY", "xcsec-service-role");
    setEnv("APPLE_SIGN_IN_CLIENT_ID", "com.picklesensei");
    setEnv("APPLE_SIGN_IN_TEAM_ID", "XCSECTEAM1");
    setEnv("APPLE_SIGN_IN_KEY_ID", "XCSECKEY01");
    setEnv("APPLE_SIGN_IN_PRIVATE_KEY", await p256Pkcs8Pem());
    setEnv(
      "APPLE_TOKEN_ENCRYPTION_KEY",
      btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
    );
    try {
      advanceClock();
      const before = outbound.length;
      const sync = await send(
        "POST",
        "/v1/billing/sync",
        jsonInit(
          { appUserId: "../../v1/XCSEC_CANARY_SSRF1", platform: "ios" },
          { "x-forwarded-for": "203.0.113.80" },
        ),
      );
      rows.push({
        route: "POST /v1/billing/sync",
        body: { appUserId: "../../v1/XCSEC_CANARY_SSRF1" },
        status: sync.status,
        outbound: outbound.slice(before),
      });
      const hostileIds = [
        "../../v1/XCSEC_CANARY_SSRF2",
        "http://169.254.169.254/latest/meta-data/",
        "XCSEC_CANARY_SSRF3%2f..%2f",
        "$RCAnonymousID:abc",
        "11111111-1111-4111-8111-111111111111",
        "11111111-1111-4111-8111-111111111111/../XCSEC_CANARY_SSRF4",
        "11111111-1111-4111-8111-111111111111?x=XCSEC_CANARY_SSRF5",
        "11111111-1111-4111-8111-111111111111#XCSEC_CANARY_SSRF6",
        "11111111-1111-4111-8111-111111111111@evil.example",
      ];
      for (const id of hostileIds) {
        const mark = outbound.length;
        const out = await sendPublic("POST", "/webhooks/revenuecat", {
          headers: {
            "Content-Type": "application/json",
            Authorization: "xcsec-webhook-auth",
            "x-forwarded-for": "203.0.113.81",
          },
          body: JSON.stringify({
            event: {
              id: `evt-${crypto.randomUUID()}`,
              type: "TEST",
              app_user_id: id,
              aliases: [id],
              transferred_from: [id],
              transferred_to: [id],
            },
          }),
        });
        rows.push({
          route: "POST /webhooks/revenuecat",
          app_user_id: id,
          status: out.status,
          outbound: outbound.slice(mark),
        });
      }
      advanceClock();
      const mark2 = outbound.length;
      const hosted = await send(
        "POST",
        "/v1/billing/sync",
        jsonInit(
          { platform: "ios" },
          {
            "x-forwarded-host": "evil.example",
            "x-forwarded-proto": "gopher",
            forwarded: "host=evil.example",
            host: "evil.example",
            "x-forwarded-for": "203.0.113.82",
          },
        ),
      );
      rows.push({
        route: "POST /v1/billing/sync (forwarded-host/host)",
        status: hosted.status,
        outbound: outbound.slice(mark2),
      });
      // Apple authorization-code exchange: the code is attacker-shaped and must
      // land ONLY as a form field of the fixed Apple token URL.
      for (const code of [
        "XCSEC_CANARY_CODE&redirect_uri=https://evil.example&client_id=evil",
        "../../XCSEC_CANARY_CODE2",
        "code\r\nHost: evil.example",
        "x".repeat(4096),
        "x".repeat(4097),
      ]) {
        advanceClock();
        const mark = outbound.length;
        const out = await send(
          "POST",
          "/v1/account/bootstrap",
          jsonInit(
            { appleAuthorizationCode: code },
            { "X-Apple-Revocation-Protocol": "1", "x-forwarded-for": "203.0.113.83" },
          ),
          fakeAppleIdToken(),
        );
        const calls = outbound.slice(mark);
        rows.push({
          route: "POST /v1/account/bootstrap (apple code)",
          code: code.length > 60 ? `${code.slice(0, 60)}…(${code.length})` : code,
          status: out.status,
          responseCode: (out.body as { code?: string } | null)?.code ?? null,
          outbound: calls.map((c) => ({
            url: c.url,
            method: c.method,
            bodyKeys: c.body ? [...new URLSearchParams(c.body).keys()] : null,
            codeField: c.body ? new URLSearchParams(c.body).get("code")?.slice(0, 40) : null,
            secretInBody: c.body?.includes("xcsec") ?? false,
          })),
        });
      }
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
      tap.stop();
    }
    const origins = [...new Set(outbound.map((o) => new URL(o.url).origin))].sort();
    const paths = outbound.map((o) => new URL(o.url).pathname + new URL(o.url).search);
    const artifact = await writeArtifact("ssrf_matrix.json", {
      rows,
      outboundAll: outbound.map((o) => ({
        ...o,
        body: o.body ? o.body.replace(/client_secret=[^&]+/, "client_secret=<redacted>") : null,
      })),
      origins,
      console: tap.console,
    });
    summary.ssrf = { cases: rows.length, outboundCalls: outbound.length, origins, artifact };
    const ALLOWED = new Set(["https://api.revenuecat.com", "https://appleid.apple.com"]);
    for (const o of origins) assert(ALLOWED.has(o), `unexpected outbound origin ${o}`);
    for (const p of paths) {
      assert(
        /^\/v1\/subscribers\/[0-9a-f-]{36}$/.test(p) || p === "/auth/token" || p === "/auth/revoke",
        `outbound path carries attacker text: ${p}`,
      );
      assert(!p.includes("XCSEC"), `canary reached an outbound URL: ${p}`);
    }
    assert(
      origins.includes("https://api.revenuecat.com"),
      "RevenueCat verification must have been exercised",
    );
    assert(
      origins.includes("https://appleid.apple.com"),
      "Apple token exchange must have been exercised",
    );
    for (const o of outbound) {
      if (o.body) {
        const form = new URLSearchParams(o.body);
        const code = form.get("code") ?? "";
        assert(
          !code.includes("&") || form.get("redirect_uri") === null,
          "attacker code split into extra form fields",
        );
        assert(
          form.get("client_id") === "com.picklesensei",
          "client_id overridden by attacker code",
        );
      }
    }
    for (const line of tap.console)
      assert(
        !/xcsec-not-a-real-key|xcsec-service-role|xcsec-webhook-auth|BEGIN PRIVATE KEY/.test(
          line.line,
        ),
        `secret leaked to console: ${line.line}`,
      );
    for (const line of tap.console)
      assert(canariesIn(line.line).length === 0, `canary reached console: ${line.line}`);
  },
);

// ─── prototype snapshot + summary ───────────────────────────────────────────

function countCanaries(c: ReturnType<typeof classifyCanaries>) {
  return {
    console: c.console.length,
    accessRequestId: c.accessRequestId.length,
    accessRoute: c.accessRoute.length,
    accessOther: c.accessOther.length,
  };
}

Deno.test(
  "xcsec: Object/Array/Function prototypes are unchanged after the whole matrix; summary",
  async () => {
    await bootEdgeFunction();
    resetRest();
    installDefaultResponder();
    advanceClock();
    const diff = protoDiff(protoBefore, protoSnapshot());
    const me = await send("GET", "/v1/me", { headers: { "x-forwarded-for": "203.0.113.90" } });
    summary.protoDiff = diff;
    summary.meAfter = { status: me.status };
    summary.heapAtEnd = heap();
    summary.clockOffsetMs = clockOffset();
    summary.finishedAt = new Date().toISOString();
    summary.userId = USER_ID;
    summary.bearerKind = "google id token (fake auth)";
    summary.tokenSample = fakeGoogleIdToken().slice(0, 12) + "…";
    summary.observations = observations;
    const artifact = await writeArtifact("summary.json", summary);
    summary.artifact = artifact;
    assertEquals(diff, []);
    assertEquals(me.status, 200, me.text);
    setRestResponder(() => restJson(200, []));
    resetRest();
  },
);
