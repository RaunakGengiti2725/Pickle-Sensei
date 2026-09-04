// XC journey-offline-first — edge plane.
//
// Black-box tests of POST /v1/shots:sync through the REAL edge handler
// (auth → rate limit → routing → syncShots) against a local fake Supabase
// (GoTrue getUser + PostgREST `shots` lookup + `apply_synced_shot` RPC) so
// no hosted project is touched. This is the server half of the offline-first
// journey: a device reconnects and flushes a mixed batch; the server must
// accept some, reject the rest PER SHOT with the stable codes the mobile
// outbox keys on (apps/mobile/src/data/sync.ts), never drop a shot silently,
// and acknowledge replays idempotently without re-running the RPC.
//
// Run from the repo root:
//   deno test -A --no-check --config supabase/functions/api/__wf__/deno.json \
//     supabase/functions/api/__wf__/xc_journey_offline_first_shots_sync.test.ts
//
// Artifacts (JSON tables) are written under
//   artifacts/xc-offline-first/edge/  (override with XC_OFFLINE_ARTIFACT_DIR).

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

// ─── Fake Supabase ──────────────────────────────────────────────────────────

/** Scripted verdict for one shot id. `accepted` also commits the row so a
 * replay is visible to the idempotency lookup, exactly like the real RPC. */
type Verdict =
  | { kind: "accepted" }
  | { kind: "status"; status: string }
  | { kind: "rpc_http_error"; httpStatus: number }
  | { kind: "throw" };

interface RpcCall {
  shotId: string;
  userToken: string;
  shot: Record<string, unknown>;
}

interface FakeState {
  verdicts: Map<string, Verdict>;
  /** user id → shot ids committed by an accepted RPC. */
  committed: Map<string, Set<string>>;
  rpcCalls: RpcCall[];
  lookupCalls: Array<{ userToken: string; url: string }>;
  /** When set, PostgREST answers the `shots` lookup with this HTTP status. */
  lookupHttpStatus: number | null;
}

const state: FakeState = {
  verdicts: new Map(),
  committed: new Map(),
  rpcCalls: [],
  lookupCalls: [],
  lookupHttpStatus: null,
};

function resetState(): void {
  state.verdicts = new Map();
  state.committed = new Map();
  state.rpcCalls = [];
  state.lookupCalls = [];
  state.lookupHttpStatus = null;
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const b64url = (input: string): string =>
  btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let fakeUrl = "";

/** Supabase-issued access token shape (iss ends with /auth/v1): the handler
 * verifies it with GoTrue getUser — our fake maps `sub` straight to a user. */
function accessToken(userId: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${fakeUrl}/auth/v1`,
      sub: userId,
      role: "authenticated",
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    }),
  );
  return `${header}.${payload}.sig`;
}

function userIdOfBearer(request: Request): string | null {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    const claims = JSON.parse(atob(segment.replace(/-/g, "+").replace(/_/g, "/"))) as {
      sub?: string;
    };
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

async function fakeSupabase(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET" && path === "/auth/v1/user") {
    const userId = userIdOfBearer(request);
    if (!userId) return jsonResponse(401, { code: 401, msg: "invalid JWT" });
    return jsonResponse(200, {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: `${userId}@example.com`,
      app_metadata: { provider: "google", providers: ["google"] },
      user_metadata: {},
      created_at: new Date().toISOString(),
    });
  }

  if (request.method === "GET" && path === "/rest/v1/shots") {
    const userId = userIdOfBearer(request) ?? "";
    state.lookupCalls.push({ userToken: userId, url: request.url });
    if (state.lookupHttpStatus !== null) {
      return jsonResponse(state.lookupHttpStatus, {
        code: "XX000",
        message: "fake lookup failure",
      });
    }
    // PostgREST filter: user_id=eq.<id>&id=in.(a,b,c)
    const userFilter = url.searchParams.get("user_id") ?? "";
    const idFilter = url.searchParams.get("id") ?? "";
    const filteredUser = userFilter.startsWith("eq.") ? userFilter.slice(3) : "";
    const ids = idFilter.startsWith("in.(")
      ? idFilter
          .slice(4, -1)
          .split(",")
          .map((s) => s.replace(/^"|"$/g, ""))
      : [];
    const owned = state.committed.get(filteredUser) ?? new Set<string>();
    return jsonResponse(
      200,
      ids.filter((id) => owned.has(id)).map((id) => ({ id })),
    );
  }

  if (request.method === "POST" && path === "/rest/v1/rpc/apply_synced_shot") {
    const userId = userIdOfBearer(request) ?? "";
    const body = (await request.json()) as { shot: Record<string, unknown> };
    const shotId = String(body.shot.id);
    state.rpcCalls.push({ shotId, userToken: userId, shot: body.shot });
    const verdict = state.verdicts.get(shotId) ?? { kind: "accepted" };
    switch (verdict.kind) {
      case "accepted": {
        const set = state.committed.get(userId) ?? new Set<string>();
        set.add(shotId);
        state.committed.set(userId, set);
        return jsonResponse(200, "accepted");
      }
      case "status":
        return jsonResponse(200, verdict.status);
      case "rpc_http_error":
        return jsonResponse(verdict.httpStatus, {
          code: "P0001",
          message: "fake rpc failure",
        });
      case "throw":
        throw new Error("fake connection reset");
    }
  }

  if (path === "/rest/v1/rpc/access_state" && request.method === "POST") {
    return jsonResponse(200, [{ premium: false, scored_count: 0, reserved_count: 0 }]);
  }

  return jsonResponse(404, { message: `fake supabase: unhandled ${request.method} ${path}` });
}

// ─── Boot the Edge Function in-process ───────────────────────────────────────

const fake = Deno.serve({ port: 0, onListen: () => undefined }, fakeSupabase);
fakeUrl = `http://127.0.0.1:${fake.addr.port}`;

Deno.env.set("SUPABASE_URL", fakeUrl);
Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_revenuecat");
Deno.env.delete("UPSTASH_REDIS_REST_URL");
Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

type Handler = (request: Request) => Promise<Response> | Response;
let handler: Handler | null = null;
const realServe = Deno.serve;
(Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
  handler = (typeof args[0] === "function" ? args[0] : args[1]) as Handler;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
};
await import("../index.ts");
(Deno as unknown as { serve: unknown }).serve = realServe;
if (!handler) throw new Error("index.ts did not register a Deno.serve handler");
const api: Handler = handler;

let ipCounter = 0;
const nextIp = (): string => `203.0.113.${(ipCounter++ % 250) + 1}`;

interface SyncResponse {
  acceptedIds: string[];
  rejected: Array<{ id: string; code: string; message: string }>;
}

async function postSync(
  userId: string,
  body: unknown,
  ip: string = nextIp(),
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const response = await api(
    new Request("http://edge.local/functions/v1/api/v1/shots:sync", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken(userId)}`,
        "Content-Type": "application/json",
        "x-forwarded-for": ip,
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    headers: response.headers,
  };
}

// ─── Payload builder (mirrors apps/mobile/src/data/sync.ts toSyncPayload) ────

/** Deterministic xorshift32 so every batch is replayable from its seed. */
function makeRng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
  const uuid = () => {
    const hex = () => Math.floor(next() * 16).toString(16);
    const block = (n: number) => Array.from({ length: n }, hex).join("");
    return `${block(8)}-${block(4)}-4${block(3)}-${(8 + Math.floor(next() * 4)).toString(16)}${block(
      3,
    )}-${block(12)}`;
  };
  return { next, uuid, int: (n: number) => Math.floor(next() * n) };
}

const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "config-1",
};

function shotPayload(
  rng: ReturnType<typeof makeRng>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: rng.uuid(),
    analysisPermitId: rng.uuid(),
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-04T12:00:00.000Z",
    timestamps: { startMs: 0, contactMs: 400, endMs: 900 },
    overallScore: Math.round(rng.next() * 100) / 10,
    confidence: 0.9,
    resultKind: "scored",
    source: "real",
    phases: [
      { key: "setup", startMs: 0, representativeMs: 100, endMs: 300, confidence: 0.9 },
      { key: "contact", startMs: 300, representativeMs: 400, endMs: 500, confidence: 0.9 },
    ],
    checkpoints: [
      {
        key: "paddle_face",
        score: 70,
        confidence: 0.8,
        band: "yellow",
        direction: "hold",
        severity: 0.2,
        applicable: true,
      },
    ],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

// ─── Artifacts ───────────────────────────────────────────────────────────────

const ARTIFACT_DIR =
  Deno.env.get("XC_OFFLINE_ARTIFACT_DIR") ??
  new URL("../../../../artifacts/xc-offline-first/edge/", import.meta.url).pathname;

async function writeArtifact(name: string, value: unknown): Promise<string> {
  await Deno.mkdir(ARTIFACT_DIR, { recursive: true });
  const path = `${ARTIFACT_DIR}${ARTIFACT_DIR.endsWith("/") ? "" : "/"}${name}`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}

const USER_A = "0000c0de-a11e-4a00-8000-00000000000a";
const USER_B = "0000c0de-a11e-4b00-8000-00000000000b";

// ─── Tests ───────────────────────────────────────────────────────────────────

Deno.test(
  "mixed reconnect batch: every shot is accepted or rejected exactly once with its own stable code",
  async () => {
    resetState();
    const rng = makeRng(7001);
    const ok1 = shotPayload(rng);
    const ok2 = shotPayload(rng, { sessionId: rng.uuid() });
    const paywall = shotPayload(rng);
    const noSession = shotPayload(rng, { sessionId: rng.uuid() });
    const conflict = shotPayload(rng);
    const expiredPermit = shotPayload(rng);
    const rpcDown = shotPayload(rng);
    const rpcDetail = shotPayload(rng);
    const malformedPermit = shotPayload(rng, { analysisPermitId: "not-a-uuid" });
    const nonReal = shotPayload(rng, { source: "synthetic" });
    const lowConfBadScore = shotPayload(rng, { resultKind: "low_confidence", overallScore: 4.2 });
    const badPhase = shotPayload(rng, {
      phases: [
        { key: "setup", startMs: 0, representativeMs: 100, endMs: 300, confidence: 0.9 },
        {
          key: "setup",
          startMs: 1,
          representativeMs: 2,
          endMs: 3,
          confidence: 0.5,
        },
      ],
    });
    const notAnObject = 42;

    state.verdicts.set(String(paywall.id), { kind: "status", status: "access.paywall_required" });
    state.verdicts.set(String(noSession.id), { kind: "status", status: "shot.session_not_found" });
    state.verdicts.set(String(conflict.id), { kind: "status", status: "shot.id_conflict" });
    state.verdicts.set(String(expiredPermit.id), {
      kind: "status",
      status: "access.permit_expired",
    });
    state.verdicts.set(String(rpcDown.id), { kind: "rpc_http_error", httpStatus: 500 });
    state.verdicts.set(String(rpcDetail.id), {
      kind: "status",
      status: "shot.write_failed:duplicate key value violates unique constraint",
    });

    const batch = [
      ok1,
      paywall,
      malformedPermit,
      ok2,
      noSession,
      nonReal,
      conflict,
      lowConfBadScore,
      expiredPermit,
      rpcDown,
      badPhase,
      rpcDetail,
      notAnObject,
    ];
    const res = await postSync(USER_A, { shots: batch });
    const body = res.json as unknown as SyncResponse;
    const rejectedById = new Map(body.rejected.map((r) => [r.id, r]));

    const table = batch.map((entry) => {
      const id =
        typeof entry === "object" && entry ? String((entry as { id: unknown }).id) : "unknown";
      return {
        id,
        accepted: body.acceptedIds.includes(id),
        rejection: rejectedById.get(id) ?? null,
        rpcCalls: state.rpcCalls.filter((c) => c.shotId === id).length,
      };
    });
    const artifact = await writeArtifact("mixed-batch.json", {
      seed: 7001,
      status: res.status,
      request: batch,
      response: body,
      table,
      lookupCalls: state.lookupCalls.length,
      rpcCalls: state.rpcCalls.map((c) => c.shotId),
    });
    console.log(`artifact: ${artifact}`);

    assertEquals(res.status, 200);
    assertEquals(body.acceptedIds.sort(), [String(ok1.id), String(ok2.id)].sort());

    // Exactly one verdict per entry — nothing accepted AND rejected, nothing dropped.
    const allIds = batch.map((e) =>
      typeof e === "object" && e ? String((e as { id: unknown }).id) : "unknown",
    );
    const verdictIds = [...body.acceptedIds, ...body.rejected.map((r) => r.id)].sort();
    assertEquals(verdictIds, [...allIds].sort());
    for (const id of body.acceptedIds)
      assert(!rejectedById.has(id), `${id} both accepted+rejected`);

    const code = (shot: Record<string, unknown>) => rejectedById.get(String(shot.id))?.code;
    assertEquals(code(paywall), "access.paywall_required");
    assertEquals(code(noSession), "shot.session_not_found");
    assertEquals(code(conflict), "shot.id_conflict");
    assertEquals(code(expiredPermit), "access.permit_expired");
    assertEquals(code(rpcDown), "shot.write_failed");
    assertEquals(code(rpcDetail), "shot.write_failed");
    assertEquals(code(malformedPermit), "shot.invalid_payload");
    assertEquals(code(nonReal), "shot.non_real_source");
    assertEquals(code(lowConfBadScore), "shot.invalid_payload");
    assertEquals(code(badPhase), "shot.invalid_payload");
    assertEquals(rejectedById.get("unknown")?.code, "shot.invalid_payload");

    // Honest copy: the retryable write failure tells the device its data stays
    // and will retry; DB detail never leaks into the response.
    const writeFailed = rejectedById.get(String(rpcDetail.id))!;
    assertStringIncludes(writeFailed.message, "It stays on this device and will retry.");
    assert(!writeFailed.message.includes("duplicate key"), "DB detail leaked");
    assert(!JSON.stringify(body).includes("unique constraint"), "DB detail leaked");
    assertStringIncludes(
      rejectedById.get(String(paywall.id))!.message,
      "Both lifetime free ratings have been used.",
    );

    // Malformed entries never cost a query; every parsed entry cost exactly one RPC.
    const parsedIds = [ok1, ok2, paywall, noSession, conflict, expiredPermit, rpcDown, rpcDetail]
      .map((s) => String(s.id))
      .sort();
    assertEquals(state.rpcCalls.map((c) => c.shotId).sort(), parsedIds);
    assertEquals(state.lookupCalls.length, 1);

    // The RPC received the canonical shape (timestamps flattened, permit carried).
    const rpcOk1 = state.rpcCalls.find((c) => c.shotId === String(ok1.id))!;
    assertEquals(rpcOk1.shot.analysisPermitId, ok1.analysisPermitId);
    assertEquals(rpcOk1.shot.startMs, 0);
    assertEquals(rpcOk1.shot.contactMs, 400);
    assertEquals(rpcOk1.shot.endMs, 900);
    assertEquals(rpcOk1.userToken, USER_A);
  },
);

Deno.test(
  "replaying the same batch acknowledges committed shots without re-running the RPC and re-adjudicates the rest",
  async () => {
    resetState();
    const rng = makeRng(7002);
    const ok = shotPayload(rng);
    const paywall = shotPayload(rng);
    const flaky = shotPayload(rng);
    state.verdicts.set(String(paywall.id), { kind: "status", status: "access.paywall_required" });
    state.verdicts.set(String(flaky.id), { kind: "rpc_http_error", httpStatus: 500 });

    const first = (await postSync(USER_A, { shots: [ok, paywall, flaky] }))
      .json as unknown as SyncResponse;
    assertEquals(first.acceptedIds, [String(ok.id)]);
    assertEquals(first.rejected.map((r) => r.code).sort(), [
      "access.paywall_required",
      "shot.write_failed",
    ]);
    const rpcAfterFirst = state.rpcCalls.length;
    assertEquals(rpcAfterFirst, 3);

    // Device reconnects again and flushes the same three (the outbox kept all
    // rows that lacked a receipt; `ok` would normally be gone but a receipt
    // write that raced a crash may replay it too). The write failure clears.
    state.verdicts.delete(String(flaky.id));
    const second = (await postSync(USER_A, { shots: [ok, paywall, flaky] }))
      .json as unknown as SyncResponse;
    const artifact = await writeArtifact("replay.json", {
      seed: 7002,
      first,
      second,
      rpcCalls: state.rpcCalls.map((c) => c.shotId),
      lookupCalls: state.lookupCalls,
    });
    console.log(`artifact: ${artifact}`);

    assertEquals(second.acceptedIds.sort(), [String(ok.id), String(flaky.id)].sort());
    assertEquals(
      second.rejected.map((r) => r.id),
      [String(paywall.id)],
    );
    // `ok` was acknowledged from the lookup, never re-applied.
    assertEquals(state.rpcCalls.filter((c) => c.shotId === String(ok.id)).length, 1);
    assertEquals(state.rpcCalls.length, rpcAfterFirst + 2);
    // Third flush: only paywall remains rejected; nothing new is written.
    const third = (await postSync(USER_A, { shots: [ok, paywall, flaky] }))
      .json as unknown as SyncResponse;
    assertEquals(third.acceptedIds.sort(), second.acceptedIds.sort());
    assertEquals(state.rpcCalls.length, rpcAfterFirst + 3);
  },
);

Deno.test(
  "another account replaying the same shot ids is NOT acknowledged from the owner's rows",
  async () => {
    resetState();
    const rng = makeRng(7003);
    const shot = shotPayload(rng);
    const first = (await postSync(USER_A, { shots: [shot] })).json as unknown as SyncResponse;
    assertEquals(first.acceptedIds, [String(shot.id)]);

    // The RPC (real: unique shots.id + RLS) answers id_conflict for user B.
    state.verdicts.set(String(shot.id), { kind: "status", status: "shot.id_conflict" });
    const asB = (await postSync(USER_B, { shots: [shot] })).json as unknown as SyncResponse;
    const artifact = await writeArtifact("cross-account-replay.json", {
      seed: 7003,
      asA: first,
      asB,
      lookupCalls: state.lookupCalls,
      rpcCalls: state.rpcCalls.map((c) => ({ shotId: c.shotId, user: c.userToken })),
    });
    console.log(`artifact: ${artifact}`);

    assertEquals(asB.acceptedIds, []);
    assertEquals(
      asB.rejected.map((r) => r.code),
      ["shot.id_conflict"],
    );
    // The lookup for B ran under B's bearer (RLS scope), and B's RPC ran under B.
    assertEquals(
      state.lookupCalls.map((c) => c.userToken),
      [USER_A, USER_B],
    );
    assertEquals(
      state.rpcCalls.map((c) => c.userToken),
      [USER_A, USER_B],
    );
  },
);

Deno.test(
  "idempotency lookup outage → 503 for the WHOLE batch before any shot is written (retryable for the outbox)",
  async () => {
    resetState();
    const rng = makeRng(7004);
    const shots = [shotPayload(rng), shotPayload(rng), shotPayload(rng)];
    state.lookupHttpStatus = 500;
    const res = await postSync(USER_A, { shots });
    const artifact = await writeArtifact("lookup-outage.json", {
      seed: 7004,
      status: res.status,
      body: res.json,
      rpcCalls: state.rpcCalls.length,
    });
    console.log(`artifact: ${artifact}`);

    assertEquals(res.status, 503);
    assertEquals(state.rpcCalls.length, 0);
    const error = (res.json as { error?: { message?: string } }).error;
    assertStringIncludes(String(error?.message), "temporarily unavailable");
    assert(!JSON.stringify(res.json).includes("fake lookup failure"), "DB detail leaked");

    // Once the outage clears the identical flush succeeds in full.
    state.lookupHttpStatus = null;
    const retry = await postSync(USER_A, { shots });
    assertEquals(retry.status, 200);
    assertEquals((retry.json as unknown as SyncResponse).acceptedIds.length, 3);
  },
);

Deno.test(
  "batch envelope: 0 and 201 shots are refused with validation.shots_sync; 200 is the ceiling",
  async () => {
    resetState();
    const rng = makeRng(7005);
    const empty = await postSync(USER_A, { shots: [] });
    assertEquals(empty.status, 400);
    assertEquals(
      (empty.json as { error?: { code?: string } }).error?.code,
      "validation.shots_sync",
    );

    const notArray = await postSync(USER_A, { shots: { id: "x" } });
    assertEquals(notArray.status, 400);

    const over = Array.from({ length: 201 }, () => shotPayload(rng));
    const tooMany = await postSync(USER_A, { shots: over });
    assertEquals(tooMany.status, 400);
    assertEquals(state.rpcCalls.length, 0);

    const full = await postSync(USER_A, { shots: over.slice(0, 200) });
    assertEquals(full.status, 200);
    assertEquals((full.json as unknown as SyncResponse).acceptedIds.length, 200);
    const artifact = await writeArtifact("envelope-bounds.json", {
      seed: 7005,
      empty: empty.status,
      notArray: notArray.status,
      tooMany: tooMany.status,
      full: full.status,
      fullAccepted: (full.json as unknown as SyncResponse).acceptedIds.length,
    });
    console.log(`artifact: ${artifact}`);
  },
);

Deno.test(
  "seeded 200-shot batches × 10: verdict set equals request set, codes match the scripted RPC outcomes",
  async () => {
    resetState();
    const outcomes = [
      "accepted",
      "accepted",
      "accepted",
      "access.paywall_required",
      "shot.session_not_found",
      "access.permit_not_reserved",
      "access.permit_expired",
      "access.permit_not_found",
      "shot.id_conflict",
      "auth.required",
      "shot.write_failed:detail",
      "rpc_http_500",
      "malformed",
    ] as const;
    const runs: Array<Record<string, unknown>> = [];
    let totalShots = 0;
    for (let seed = 8101; seed < 8111; seed++) {
      resetState();
      const rng = makeRng(seed);
      const user = rng.uuid();
      const expected = new Map<string, string>();
      const shots: unknown[] = [];
      for (let i = 0; i < 200; i++) {
        const outcome = outcomes[rng.int(outcomes.length)];
        if (outcome === "malformed") {
          const shot = shotPayload(rng, { cameraView: "front" });
          expected.set(String(shot.id), "shot.invalid_payload");
          shots.push(shot);
          continue;
        }
        const shot = shotPayload(rng);
        shots.push(shot);
        if (outcome === "accepted") {
          expected.set(String(shot.id), "accepted");
        } else if (outcome === "rpc_http_500") {
          state.verdicts.set(String(shot.id), { kind: "rpc_http_error", httpStatus: 500 });
          expected.set(String(shot.id), "shot.write_failed");
        } else if (outcome === "shot.write_failed:detail") {
          state.verdicts.set(String(shot.id), { kind: "status", status: outcome });
          expected.set(String(shot.id), "shot.write_failed");
        } else {
          state.verdicts.set(String(shot.id), { kind: "status", status: outcome });
          expected.set(String(shot.id), outcome);
        }
      }
      const started = performance.now();
      const res = await postSync(user, { shots });
      const elapsedMs = performance.now() - started;
      const body = res.json as unknown as SyncResponse;
      const actual = new Map<string, string>();
      for (const id of body.acceptedIds) actual.set(id, "accepted");
      for (const r of body.rejected) {
        assert(!actual.has(r.id), `${r.id} has two verdicts`);
        actual.set(r.id, r.code);
      }
      const mismatches = [...expected.entries()]
        .filter(([id, code]) => actual.get(id) !== code)
        .map(([id, code]) => ({ id, expected: code, actual: actual.get(id) ?? null }));
      const codeCounts: Record<string, number> = {};
      for (const code of actual.values()) codeCounts[code] = (codeCounts[code] ?? 0) + 1;
      runs.push({
        seed,
        user,
        status: res.status,
        elapsedMs: Math.round(elapsedMs),
        shots: shots.length,
        verdicts: actual.size,
        codeCounts,
        rpcCalls: state.rpcCalls.length,
        mismatches,
      });
      totalShots += shots.length;
      assertEquals(res.status, 200);
      assertEquals(actual.size, expected.size);
      assertEquals(mismatches, []);
      // Second flush of the identical batch: accepted ids come back from the
      // lookup, nothing accepted is re-applied.
      const rpcBefore = state.rpcCalls.length;
      const replay = (await postSync(user, { shots })).json as unknown as SyncResponse;
      assertEquals(replay.acceptedIds.sort(), body.acceptedIds.sort());
      const acceptedSet = new Set(body.acceptedIds);
      assertEquals(
        state.rpcCalls.slice(rpcBefore).filter((c) => acceptedSet.has(c.shotId)).length,
        0,
      );
    }
    const artifact = await writeArtifact("seeded-batches.json", {
      seeds: "8101..8110",
      totalShots,
      heap: Deno.memoryUsage(),
      runs,
    });
    console.log(`artifact: ${artifact}`);
  },
);

Deno.test(
  "flush cadence: the 31st shots:sync from one account within a minute is 429 with Retry-After (transient for the outbox)",
  async () => {
    resetState();
    const rng = makeRng(7006);
    const user = rng.uuid();
    const ip = nextIp();
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 31; i++) {
      const res = await postSync(user, { shots: [shotPayload(rng)] }, ip);
      statuses.push(res.status);
      if (res.status === 429) retryAfter = res.headers.get("retry-after");
    }
    const artifact = await writeArtifact("rate-limit-cadence.json", {
      seed: 7006,
      statuses,
      retryAfter,
      accepted: state.rpcCalls.length,
    });
    console.log(`artifact: ${artifact}`);
    assertEquals(
      statuses.slice(0, 30),
      Array.from({ length: 30 }, () => 200),
    );
    assertEquals(statuses[30], 429);
    assert(retryAfter !== null && Number(retryAfter) > 0, "Retry-After missing");
    // The 31st batch was never applied — the device keeps it for the next window.
    assertEquals(state.rpcCalls.length, 30);
  },
);
