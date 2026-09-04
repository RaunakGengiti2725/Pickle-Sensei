// Fuzz / boundary campaign against the REAL edge route `PUT /v1/me/onboarding`
// (../index.ts, in-process, Deno.serve captured; Supabase Auth, PostgREST and
// RevenueCat stubbed at the fetch layer).
//
// Invariants asserted on EVERY generated request:
//   I1  bad input only ever answers 400/401/403/404/405/413/415/429
//       (503 only when a fault was injected into an upstream; never 500);
//   I2  every response carries a well-formed `x-request-id` — a well-formed
//       client id is echoed, a malformed one is never reflected;
//   I3  a rejected request performs NO profiles write;
//   I4  every write touches only the six/eight whitelisted onboarding columns
//       (no mass assignment from the body) and stays inside the DB's
//       char_length caps, with control/bidi characters stripped;
//   I5  5xx bodies are generic: no stack frames, no PostgREST/SQLSTATE detail,
//       no upstream URL or key, no echo of the request payload.
//
// Scale: STRESS_ITER iterations from STRESS_SEED (default 200 iterations so the
// campaign lives in the normal suite; the reported campaign runs
// `STRESS_ITER=3000`). Every iteration is a pure function of (seed, index):
//
//   STRESS_SEED=20260904 STRESS_ONLY=1234 deno test -A --no-check \
//     --config deno.json stress_route_put_onboarding_fuzz.test.ts
//
// Results are written as a JSON seed→outcome table under
// artifacts/stress-route-put-onboarding/latest/ (STRESS_OUT_DIR overrides).

import { assert, assertEquals } from "@std/assert";
import {
  ALLOWED_PATCH_KEYS,
  DB_TEXT_CAPS,
  envInt,
  histogram,
  LEAK_MARKERS,
  loadStressHarness,
  providerIdToken,
  type RecordedWrite,
  type StressHarness,
  writeArtifact,
} from "./stress_onboarding_harness.ts";
import {
  caseFor,
  type FuzzCase,
  requestFor,
} from "./stress_onboarding_cases.ts";

const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_ITER = envInt("STRESS_ITER", 200);
const STRESS_ONLY = Deno.env.get("STRESS_ONLY");

const REJECT_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 429]);
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const CONTROL_OR_SPOOF =
  // deno-lint-ignore no-control-regex
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const STACK_FRAME = /\n\s*at\s|index\.ts:\d+|file:\/\/|\.ts:\d+:\d+/;

interface Outcome {
  index: number;
  seed: number;
  replay: string;
  expect: FuzzCase["expect"];
  method: string;
  routePath: string;
  labels: FuzzCase["labels"];
  bodyBytes: number;
  status: number;
  code: string | null;
  message: string | null;
  requestId: string | null;
  requestIdEchoed: boolean;
  patchWrites: number;
  patchKeys: string[];
  /** The exact PostgREST patch, replayed against real Postgres by
   * stress_onboarding_pg_replay.sh. */
  patchBody: Record<string, unknown> | null;
  failures: string[];
}

const bodyText = async (response: Response): Promise<string> => {
  try {
    return await response.text();
  } catch {
    return "";
  }
};

function errorParts(
  text: string,
): { code: string | null; message: string | null } {
  try {
    const parsed = JSON.parse(text) as {
      error?: { code?: unknown; message?: unknown };
    };
    const err = parsed.error;
    if (!err || typeof err !== "object") return { code: null, message: null };
    return {
      code: typeof err.code === "string" ? err.code : null,
      message: typeof err.message === "string" ? err.message : null,
    };
  } catch {
    return { code: null, message: null };
  }
}

function checkWrite(
  write: RecordedWrite,
  c: FuzzCase,
  failures: string[],
): void {
  for (const key of Object.keys(write.body)) {
    if (!ALLOWED_PATCH_KEYS.has(key)) {
      failures.push(`I4 mass assignment: profiles PATCH carried "${key}"`);
    }
  }
  if (write.body.onboarding_state !== "complete") {
    failures.push(
      `I4 onboarding_state written as ${
        JSON.stringify(write.body.onboarding_state)
      }`,
    );
  }
  if (!write.query.includes(`id=eq.${c.sub}`)) {
    failures.push(`I4 write not scoped to the caller: ${write.query}`);
  }
  for (const [key, value] of Object.entries(write.body)) {
    if (typeof value !== "string") continue;
    if (CONTROL_OR_SPOOF.test(value)) {
      failures.push(`I4 unsanitized control/bidi character stored in ${key}`);
    }
    const cap = DB_TEXT_CAPS[key];
    if (cap !== undefined && Array.from(value).length > cap) {
      failures.push(
        `I4 ${key} is ${
          Array.from(value).length
        } code points, DB cap is ${cap}`,
      );
    }
  }
}

async function runCase(harness: StressHarness, c: FuzzCase): Promise<Outcome> {
  harness.reset(c.fault);
  const response = await harness.handler(requestFor(c));
  const text = await bodyText(response);
  const { code, message } = errorParts(text);
  const requestId = response.headers.get("x-request-id");
  const patches = harness.writes.filter((w) =>
    w.method === "PATCH" && w.table === "profiles"
  );
  const failures: string[] = [];

  // I2 — request id.
  if (!requestId || !REQUEST_ID_RE.test(requestId)) {
    failures.push(
      `I2 missing/malformed x-request-id: ${JSON.stringify(requestId)}`,
    );
  }
  if (c.requestIdValidIn && requestId !== c.requestIdIn?.trim()) {
    failures.push("I2 well-formed client x-request-id was not echoed");
  }
  if (
    c.requestIdIn !== null && !c.requestIdValidIn && requestId === c.requestIdIn
  ) {
    failures.push("I2 malformed client x-request-id was reflected");
  }

  // I5 — no internal detail in ANY body (5xx especially).
  for (const marker of LEAK_MARKERS) {
    if (text.includes(marker)) {
      failures.push(`I5 response body leaked "${marker}"`);
    }
  }
  if (STACK_FRAME.test(text)) {
    failures.push("I5 response body looks like a stack frame / file path");
  }
  if (response.status >= 500) {
    if (
      !message || !/temporarily unavailable|Something went wrong/.test(message)
    ) {
      failures.push(`I5 non-generic 5xx body: ${text.slice(0, 200)}`);
    }
  }

  // I1 / I3 — status envelope and no write on rejection.
  const faulted = c.fault !== "none";
  if (response.status === 500) {
    failures.push("I1 unhandled 500 (handler threw)");
  }
  if (response.status === 200) {
    if (c.expect === "reject") {
      failures.push("I1 bad input was ACCEPTED (200)");
    }
    if (patches.length !== 1) {
      failures.push(
        `I3 accepted request issued ${patches.length} profiles PATCH calls`,
      );
    }
  } else if (REJECT_STATUSES.has(response.status)) {
    if (c.expect === "accept" && !faulted) {
      failures.push(
        `I1 valid input rejected with ${response.status} (${message ?? ""})`,
      );
    }
    if (patches.length !== 0) {
      failures.push(
        `I3 rejected request (${response.status}) still wrote to profiles`,
      );
    }
  } else if (response.status === 503) {
    if (!faulted) failures.push("I1 unfaulted request answered 503");
  } else {
    failures.push(
      `I1 status ${response.status} is outside the allowed envelope`,
    );
  }

  // I4 — column whitelist / caps on every write that happened.
  for (const write of patches) checkWrite(write, c, failures);

  // Accepted-path exactness (fault-free only: a fault can turn a valid
  // request into a legitimate 503).
  if (c.expect === "accept" && !faulted) {
    if (response.status !== 200) {
      // already reported above
    } else {
      const patch = patches[0];
      if (patch) {
        assert(c.expectedPatch);
        const got = patch.body;
        for (const [key, value] of Object.entries(c.expectedPatch)) {
          if (got[key] !== value) {
            failures.push(
              `I4 ${key} written as ${JSON.stringify(got[key])}, expected ${
                JSON.stringify(value)
              }`,
            );
          }
        }
        for (const key of Object.keys(got)) {
          if (!(key in c.expectedPatch)) {
            failures.push(`I4 unexpected column ${key} in the write`);
          }
        }
      }
      try {
        const payload = JSON.parse(text) as {
          plan?: { focusCheckpoint?: string };
          recommendedCheckpoint?: string;
        };
        if (payload.recommendedCheckpoint !== c.expectedFocus) {
          failures.push(
            `focusCheckpoint ${payload.recommendedCheckpoint} != expected ${c.expectedFocus}`,
          );
        }
      } catch {
        failures.push("accepted response was not JSON");
      }
    }
  }

  if (harness.unexpected.length > 0) {
    failures.push(
      `harness saw unstubbed upstream calls: ${harness.unexpected.join(", ")}`,
    );
  }

  return {
    index: c.index,
    seed: c.seed,
    replay:
      `STRESS_SEED=${c.seed} STRESS_ONLY=${c.index} deno test -A --no-check --config deno.json stress_route_put_onboarding_fuzz.test.ts`,
    expect: c.expect,
    method: c.method,
    routePath: c.routePath,
    labels: c.labels,
    bodyBytes: c.bodyBytes,
    status: response.status,
    code,
    message: message ? message.slice(0, 160) : null,
    requestId,
    requestIdEchoed: Boolean(
      c.requestIdValidIn && requestId === c.requestIdIn?.trim(),
    ),
    patchWrites: patches.length,
    patchKeys: patches[0] ? Object.keys(patches[0].body).sort() : [],
    patchBody: patches[0]?.body ?? null,
    failures,
  };
}

Deno.test({
  name: "stress: PUT /v1/me/onboarding — seeded fuzz/boundary campaign",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await loadStressHarness();
    const indices = STRESS_ONLY
      ? STRESS_ONLY.split(",").map((v) => Number(v.trim())).filter((v) =>
        Number.isFinite(v)
      )
      : Array.from({ length: STRESS_ITER }, (_, i) => i);

    const outcomes: Outcome[] = [];
    const startedAt = performance.now();
    const heapBefore = Deno.memoryUsage();
    for (const index of indices) {
      outcomes.push(await runCase(harness, caseFor(STRESS_SEED, index)));
    }
    const heapAfter = Deno.memoryUsage();
    const durationMs = Math.round(performance.now() - startedAt);

    const failing = outcomes.filter((o) => o.failures.length > 0);
    const fiveXx = outcomes.filter((o) => o.status >= 500);
    const report = {
      unit: "route-put-v1-me-onboarding",
      lens: "fuzz-boundary",
      seed: STRESS_SEED,
      iterations: outcomes.length,
      durationMs,
      heap: { before: heapBefore, after: heapAfter },
      statusHistogram: histogram(outcomes.map((o) => o.status)),
      expectationHistogram: histogram(outcomes.map((o) => o.expect)),
      authHistogram: histogram(outcomes.map((o) => o.labels.auth)),
      pathHistogram: histogram(outcomes.map((o) => o.labels.path)),
      methodHistogram: histogram(outcomes.map((o) => o.labels.method)),
      faultHistogram: histogram(outcomes.map((o) => o.labels.fault)),
      requestIdHistogram: histogram(outcomes.map((o) => o.labels.requestId)),
      accepted: outcomes.filter((o) => o.status === 200).length,
      // A write on a REJECTED request. An injected DB fault legitimately
      // records the attempted PATCH (the route was accepted, the database
      // refused it), so those are excluded.
      writesOnRejection: outcomes.filter(
        (o) =>
          o.status !== 200 && o.patchWrites > 0 && o.labels.fault === "none",
      ).length,
      writeAttemptsUnderFault: outcomes.filter(
        (o) =>
          o.status !== 200 && o.patchWrites > 0 && o.labels.fault !== "none",
      ).length,
      fiveXxSeeds: fiveXx.map((o) => ({
        index: o.index,
        status: o.status,
        fault: o.labels.fault,
        message: o.message,
        replay: o.replay,
      })),
      failingSeeds: failing.map((o) => ({
        index: o.index,
        status: o.status,
        labels: o.labels,
        failures: o.failures,
        replay: o.replay,
      })),
      outcomes,
    };
    const path = await writeArtifact(
      `fuzz_seed_${STRESS_SEED}_n${outcomes.length}.json`,
      report,
    );

    console.log(
      `[stress] ${outcomes.length} iterations, seed ${STRESS_SEED}, ${durationMs}ms → ${path}`,
    );
    console.log(
      `[stress] status histogram ${JSON.stringify(report.statusHistogram)}`,
    );
    console.log(
      `[stress] accepted=${report.accepted} writes-on-rejection=${report.writesOnRejection} ` +
        `5xx=${fiveXx.length} failing=${failing.length}`,
    );
    for (const f of failing.slice(0, 20)) {
      console.log(
        `[stress] FAIL #${f.index} ${f.status} ${
          f.failures.join("; ")
        }\n  ${f.replay}`,
      );
    }

    assertEquals(
      report.writesOnRejection,
      0,
      "a rejected request wrote to profiles",
    );
    assertEquals(
      failing.length,
      0,
      `${failing.length} generated requests broke an invariant — see ${path}`,
    );
  },
});

Deno.test({
  name: "stress: PUT /v1/me/onboarding — deterministic boundary cases",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await loadStressHarness();
    const token = providerIdToken("33333333-3333-4333-8333-333333333333");
    const base = {
      skillLevel: "intermediate",
      handedness: "right",
      goal: "dinks",
      biggestProblem: "I pop dinks up at the kitchen",
    };
    const send = async (
      body: string | undefined,
      headers: Record<string, string> = {},
    ) => {
      harness.reset();
      const init: RequestInit = {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-forwarded-for": "192.0.2.44",
          ...headers,
        },
      };
      if (body !== undefined) init.body = body;
      const res = await harness.handler(
        new Request(
          "http://edge.stress.test/functions/v1/api/v1/me/onboarding",
          init,
        ),
      );
      const text = await bodyText(res);
      return {
        status: res.status,
        text,
        patches: harness.writes.filter((w) =>
          w.method === "PATCH" && w.table === "profiles"
        ),
      };
    };

    // A real body one byte past the 5 MB cap is refused, and nothing is written.
    const oversize = await send(
      JSON.stringify({ ...base, pad: "x".repeat(5_000_050) }),
    );
    assertEquals(oversize.status, 413);
    assertEquals(oversize.patches.length, 0);

    // The same body streamed WITHOUT a content-length is refused while
    // streaming (the cap is enforced on the stream, not just the header).
    harness.reset();
    const prefix = `${JSON.stringify(base).slice(0, -1)},"pad":"`;
    const streamed = await harness.handler(
      new Request("http://edge.stress.test/functions/v1/api/v1/me/onboarding", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-forwarded-for": "192.0.2.46",
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(prefix));
            const chunk = encoder.encode("x".repeat(100_000));
            for (let i = 0; i < 60; i += 1) controller.enqueue(chunk);
            controller.enqueue(encoder.encode('"}'));
            controller.close();
          },
        }),
      }),
    );
    assertEquals(streamed.status, 413);
    await bodyText(streamed);
    assertEquals(
      harness.writes.filter((w) =>
        w.method === "PATCH" && w.table === "profiles"
      ).length,
      0,
    );

    // Boundary lengths: 64 accepted / 65 refused (skillLevel, goal);
    // 256 accepted / 257 refused (biggestProblem); 40 / 41 (firstName).
    for (
      const [field, cap] of [["skillLevel", 64], ["goal", 64], [
        "biggestProblem",
        256,
      ]] as const
    ) {
      const ok = await send(
        JSON.stringify({ ...base, [field]: "a".repeat(cap) }),
      );
      assertEquals(ok.status, 200, `${field} @ ${cap} must be accepted`);
      assertEquals(ok.patches.length, 1);
      const over = await send(
        JSON.stringify({ ...base, [field]: "a".repeat(cap + 1) }),
      );
      assertEquals(over.status, 400, `${field} @ ${cap + 1} must be refused`);
      assertEquals(over.patches.length, 0);
    }
    const name40 = await send(
      JSON.stringify({ ...base, firstName: "n".repeat(40) }),
    );
    assertEquals(name40.status, 200);
    const name41 = await send(
      JSON.stringify({ ...base, firstName: "n".repeat(41) }),
    );
    assertEquals(name41.status, 400);
    assertEquals(name41.patches.length, 0);

    // Duplicate delivery of the SAME accepted payload is idempotent: identical
    // body, one write each, no accumulated state.
    const bodies = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const again = await send(JSON.stringify(base));
      assertEquals(again.status, 200);
      assertEquals(again.patches.length, 1);
      bodies.add(again.text);
    }
    assertEquals(
      bodies.size,
      1,
      "repeated identical PUTs must answer identically",
    );

    // Every injected upstream failure is a generic 503 — no PostgREST detail.
    for (
      const fault of [
        "db_500_hostile_detail",
        "db_zero_rows",
        "db_column_grant_denied",
      ] as const
    ) {
      harness.reset(fault);
      const res = await harness.handler(
        new Request(
          "http://edge.stress.test/functions/v1/api/v1/me/onboarding",
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "x-forwarded-for": "192.0.2.45",
            },
            body: JSON.stringify(base),
          },
        ),
      );
      const text = await bodyText(res);
      assertEquals(res.status, 503, `${fault} must fold into 503`);
      assert(
        /temporarily unavailable/.test(text),
        `${fault} 503 body must be the generic copy: ${text}`,
      );
      for (const marker of LEAK_MARKERS) {
        assert(!text.includes(marker), `${fault} 503 leaked "${marker}"`);
      }
      assert(res.headers.get("x-request-id"), "503 still carries a request id");
    }
  },
});
