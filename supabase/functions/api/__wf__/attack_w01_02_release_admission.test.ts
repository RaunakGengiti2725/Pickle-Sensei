// W01-02 ADVERSARIAL TESTS — attack branch devin/pp/w01-02/attack-c01576c4
// against candidate c01576c43b96c4e78e21d211a5c69b9e1b0a099f.
//
// Black-box attacks on the two chargeable admission paths of the REAL edge
// handler through routesHarness (Supabase stubbed at the fetch layer):
//   POST /v1/analysis-permits      (reserve = admission of a chargeable run)
//   POST /v1/shots:sync            (apply_synced_shot settles a scored shot)
// plus GET /v1/analysis/release-policy (the same authority read).
//
// Attack families (each Deno.test names its family):
//   ATK-1 transport failures of the authority RPC at every status class
//         (401/403/404/409/429+Retry-After/500/502/504/307 redirect/thrown
//         fetch) — must be a GENERIC retryable 503, never authorization,
//         never a chargeable RPC, no upstream detail leaked.
//   ATK-2 corrupt / partial persisted authority rows (array, scalar, null,
//         deny switch inconsistent, approval half-present, version drift,
//         string timestamps, prototype key, canonical bytes drift, oversize)
//         — must be a TYPED 409 whose `release` object satisfies the SHARED
//         AnalysisReleaseEligibility validator, never 5xx, never a reserve.
//   ATK-3 clock boundaries (validFrom/validUntil/approval/withdrawal at,
//         before and after `now`; far-future and negative epochs).
//   ATK-4 idempotent reserve replay across a withdrawal (network failure
//         between the reserve RPC and the response + policy withdrawn).
//   ATK-5 free-rating conservation in one mixed batch (replay + duplicate
//         scored + partial + abstention + malformed) without a policy.
//   ATK-6 unauthorised / malformed callers must not trigger a service-role
//         authority read (amplification) and credentials must not cross:
//         the authority read uses the service role, the chargeable RPCs the
//         user's bearer.
//   ATK-7 user-facing copy of the typed verdicts follows
//         APP_STORE_SUBMISSION.md.
//   ATK-8 GET /v1/analysis/release-policy in the production-default state
//         (nothing installed) and with a corrupt row.
//
// Tests whose name starts with "BREAK" are EXPECTED TO FAIL on the candidate:
// they encode the behaviour the attacker argues is required and the failure
// is the reproduction recorded in the attack report.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { canonicalizeOfflineJson, digestCanonicalOfflineJson } from "../canonicalDigest.ts";
import type { AnalysisReleasePolicyDocument } from "../../../../packages/shared-types/src/analysisReleasePolicy.ts";
import { isAnalysisReleaseEligibility } from "../../../../packages/shared-types/src/analysisOutcome.ts";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

const RELEASE_CODE = "access.release_not_authorized";
const POLICY_RPC = "/rest/v1/rpc/read_analysis_release_policy";
const RESERVE_RPC = "/rest/v1/rpc/reserve_analysis_permit";
const APPLY_RPC = "/rest/v1/rpc/apply_synced_shot";
const SERVICE_BEARER = "Bearer service-role-test-key";

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

const artifact = { version: "fixture-1", sha256: "a".repeat(64) };
const lineage = {
  pipeline: artifact,
  definition: artifact,
  model: artifact,
  preprocessing: artifact,
  calibration: artifact,
  dataset: artifact,
  validationReport: artifact,
  supportedDomain: artifact,
};

const now = () => Math.floor(Date.now() / 1000);

function policyDocument(
  overrides: Partial<AnalysisReleasePolicyDocument> = {},
): AnalysisReleasePolicyDocument {
  const t = now();
  return {
    schemaVersion: "analysis-release-policy-v1",
    version: "attack-policy-1",
    validFrom: t - 86_400,
    validUntil: t + 86_400,
    mechanics: { lineage },
    benchmark: {
      lineage,
      uncertainty: {
        kind: "calibrated_prediction_interval",
        nominalCoverage: 0.9,
        coverageScope: "supported_slice",
        calibrationUnit: "player_session",
      },
      maximumIntervalWidth: 1.5,
      boundaryStep: 0.25,
      supportedIntervals: [{ lower: 3, upper: 5 }],
    },
    supportedInputs: [
      { shotType: "dink", cameraView: "side", handedness: "right", captureMode: "imported_video" },
    ],
    ...overrides,
  };
}

interface AuthorityRow {
  document: unknown;
  canonicalDocument: unknown;
  denyNewAuthorizations: unknown;
  approval: {
    policy: { version: unknown; sha256: unknown };
    mechanicsApprovedAt: unknown;
    benchmarkApprovedAt: unknown;
    withdrawnAt: unknown;
    denyNewAuthorizations: unknown;
  } | null;
  [extra: string]: unknown;
}

/** The row shape read_analysis_release_policy() returns for an ACTIVE policy. */
async function activeRow(
  doc: AnalysisReleasePolicyDocument = policyDocument(),
): Promise<AuthorityRow> {
  return {
    document: doc,
    canonicalDocument: canonicalizeOfflineJson(doc),
    denyNewAuthorizations: false,
    approval: {
      policy: { version: doc.version, sha256: await digestCanonicalOfflineJson(doc) },
      mechanicsApprovedAt: doc.validFrom,
      benchmarkApprovedAt: doc.validFrom,
      withdrawnAt: null,
      denyNewAuthorizations: false,
    },
  };
}

const NO_POLICY = { document: null, approval: null, denyNewAuthorizations: true };

let subject = 0;
function signIn(): { token: string; ip: string; userId: string } {
  subject += 1;
  const userId = `7a010202-0000-4000-8000-${String(subject).padStart(12, "0")}`;
  h.reset();
  h.tables.profiles = [{ id: userId, email: "u@example.com", provider: "google" }];
  h.tables.shots = [];
  h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
  h.rpcs.reserve_analysis_permit = [
    {
      result: "accepted",
      permit_id: crypto.randomUUID(),
      permit_status: "reserved",
      permit_outcome: null,
      permit_created_at: new Date().toISOString(),
    },
  ];
  h.rpcs.apply_synced_shot = "accepted";
  return { token: fakeGoogleIdToken(userId), ip: `203.0.114.${subject}`, userId };
}

function shot(resultKind: "scored" | "low_confidence" | "partial", id = crypto.randomUUID()) {
  return {
    id,
    source: "real",
    analysisPermitId: crypto.randomUUID(),
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: new Date().toISOString(),
    timestamps: { startMs: 0, contactMs: 500, endMs: 1000 },
    resultKind,
    overallScore: resultKind === "scored" ? 7.5 : null,
    confidence: resultKind === "low_confidence" ? 0.2 : 0.9,
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
  };
}

async function reserve(
  auth: { token: string; ip: string },
  idempotencyKey: string = crypto.randomUUID(),
) {
  const response = await h.handler(
    userRequest("POST", "/v1/analysis-permits", {
      token: auth.token,
      ip: auth.ip,
      body: { idempotencyKey },
    }),
  );
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function sync(auth: { token: string; ip: string }, shots: unknown[]) {
  const response = await h.handler(
    userRequest("POST", "/v1/shots:sync", { token: auth.token, ip: auth.ip, body: { shots } }),
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      acceptedIds: string[];
      rejected: Array<{ id: string; code: string; message: string }>;
    },
  };
}

// APP_STORE_SUBMISSION.md: no Android/Google Play/guest mode/Live Court/DUPR,
// no competitor names, no accuracy %, superlatives or AI-coach equivalence.
const FORBIDDEN_COPY =
  /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s?%|accura|best|most |#1|guarantee|ai coach|coach-equivalent|perfect/i;

function expectTypedRelease(
  result: { status: number; body: Record<string, unknown> },
  reasonCode: string,
) {
  assertEquals(result.status, 409, JSON.stringify(result.body));
  const error = result.body.error as Record<string, unknown>;
  assertEquals(error.code, RELEASE_CODE);
  assert(typeof error.message === "string" && error.message.length > 0);
  assert(!FORBIDDEN_COPY.test(String(error.message)), `copy: ${String(error.message)}`);
  assertEquals(result.body.release, { status: "ineligible", reasonCode });
  assert(
    isAnalysisReleaseEligibility(result.body.release),
    "release must satisfy the shared AnalysisReleaseEligibility validator",
  );
  assertEquals(h.callsTo(RESERVE_RPC).length, 0, "reserve_analysis_permit must not be invoked");
}

function expectGenericUnavailable(
  result: { status: number; body: Record<string, unknown> },
  leaked: string[],
) {
  assertEquals(result.status, 503, JSON.stringify(result.body));
  const text = JSON.stringify(result.body);
  for (const secret of leaked) assert(!text.includes(secret), `leaked upstream detail: ${secret}`);
  const error = result.body.error as Record<string, unknown>;
  assert(typeof error?.message === "string" && error.message.length > 0);
  assertEquals(h.callsTo(RESERVE_RPC).length, 0, "reserve_analysis_permit must not be invoked");
  assertEquals(h.callsTo(APPLY_RPC).length, 0, "apply_synced_shot must not be invoked");
}

// ── ATK-1 transport failures of the authority read ──────────────────────────

const TRANSPORT_STATUSES: Array<[number, Record<string, unknown>, Record<string, string>]> = [
  [401, { message: "JWSError JWSInvalidSignature" }, {}],
  [
    403,
    { code: "42501", message: "permission denied for function read_analysis_release_policy" },
    {},
  ],
  [404, {
    code: "PGRST202",
    message: "Could not find the function public.read_analysis_release_policy",
  }, {}],
  [409, { code: "23505", message: "duplicate key value" }, {}],
  [429, { message: "rate limited upstream" }, { "Retry-After": "7" }],
  [500, { code: "XX000", message: "internal upstream failure" }, {}],
  [502, { message: "bad gateway upstream" }, {}],
  [504, { message: "gateway timeout upstream" }, {}],
];

for (const [status, body, headers] of TRANSPORT_STATUSES) {
  Deno.test(`ATK-1 permit: authority RPC ${status} → generic 503, no reserve, no leak`, async () => {
    const auth = signIn();
    h.respond = (call) =>
      call.url.includes(POLICY_RPC)
        ? new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json", ...headers },
        })
        : null;
    const result = await reserve(auth);
    expectGenericUnavailable(result, [String(body.message), "read_analysis_release_policy"]);
    assertEquals(h.callsTo(POLICY_RPC).length, 1);
  });

  Deno.test(`ATK-1 sync: authority RPC ${status} → 503 for the batch, apply never called`, async () => {
    const auth = signIn();
    h.respond = (call) =>
      call.url.includes(POLICY_RPC)
        ? new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json", ...headers },
        })
        : null;
    const response = await h.handler(
      userRequest("POST", "/v1/shots:sync", {
        token: auth.token,
        ip: auth.ip,
        body: { shots: [shot("scored"), shot("partial")] },
      }),
    );
    const parsed = (await response.json()) as Record<string, unknown>;
    expectGenericUnavailable({ status: response.status, body: parsed }, [String(body.message)]);
  });
}

Deno.test("ATK-1 permit: authority RPC answers a 307 redirect → 503, redirect never followed as authority", async () => {
  const auth = signIn();
  h.respond = (call) =>
    call.url.includes(POLICY_RPC)
      ? new Response(null, {
        status: 307,
        headers: { Location: "http://attacker.test/rest/v1/rpc/read_analysis_release_policy" },
      })
      : null;
  const result = await reserve(auth);
  expectGenericUnavailable(result, ["attacker.test"]);
  assertEquals(h.callsTo("attacker.test").length, 0, "redirect target must never be fetched");
});

Deno.test("ATK-1 permit: authority RPC 200 with a non-JSON body → typed/503 but never a reserve", async () => {
  const auth = signIn();
  h.respond = (call) =>
    call.url.includes(POLICY_RPC)
      ? new Response("<html>gateway</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
      : null;
  const result = await reserve(auth);
  assert(result.status === 503 || result.status === 409, JSON.stringify(result.body));
  assertEquals(h.callsTo(RESERVE_RPC).length, 0);
});

Deno.test("ATK-1 permit: fetch to the authority throws (DNS/connection reset) → 503, no reserve", async () => {
  const auth = signIn();
  h.respond = (call) => {
    if (call.url.includes(POLICY_RPC)) throw new TypeError("connection reset by peer");
    return null;
  };
  const result = await reserve(auth);
  expectGenericUnavailable(result, ["connection reset"]);
});

Deno.test("ATK-1 sync: authority failure with a partial-only batch never consults the authority and settles", async () => {
  const auth = signIn();
  h.rpcErrors.read_analysis_release_policy = 500;
  const partial = shot("partial");
  const abstained = shot("low_confidence");
  const result = await sync(auth, [partial, abstained]);
  assertEquals(result.status, 200, JSON.stringify(result.body));
  assertEquals(result.body.acceptedIds, [partial.id, abstained.id]);
  assertEquals(h.callsTo(POLICY_RPC).length, 0);
  assertEquals(h.callsTo(APPLY_RPC).length, 2);
});

// ── ATK-2 corrupt / partial persisted authority state ───────────────────────

type Mutator = (row: AuthorityRow) => Promise<unknown> | unknown;

const CORRUPT_ROWS: Array<[string, Mutator, string]> = [
  ["row is a JSON array", () => [], "unverified"],
  ["row is a string", () => "active", "unverified"],
  ["row is a number", () => 1, "unverified"],
  ["row is JSON null (control singleton missing)", () => null, "unverified"],
  ["row is an empty object", () => ({}), "unverified"],
  [
    "nothing installed but deny switch OFF",
    () => ({ document: null, approval: null, denyNewAuthorizations: false }),
    "unverified",
  ],
  [
    "document installed, approval null, deny OFF",
    (row) => ({ ...row, approval: null }),
    "unverified",
  ],
  [
    "approval version drifts from the document version",
    (row) => ({
      ...row,
      approval: {
        ...row.approval!,
        policy: { ...row.approval!.policy, version: "attack-policy-2" },
      },
    }),
    "unverified",
  ],
  [
    "control deny=true while approval deny=false (torn read)",
    (row) => ({ ...row, denyNewAuthorizations: true }),
    "unverified",
  ],
  [
    "control deny=false while approval deny=true (torn read)",
    (row) => ({ ...row, approval: { ...row.approval!, denyNewAuthorizations: true } }),
    "unverified",
  ],
  [
    "deny switch is the string 'false'",
    (row) => ({
      ...row,
      denyNewAuthorizations: "false",
      approval: { ...row.approval!, denyNewAuthorizations: "false" },
    }),
    "unverified",
  ],
  [
    "approval timestamps are ISO strings",
    (row) => ({
      ...row,
      approval: {
        ...row.approval!,
        mechanicsApprovedAt: new Date().toISOString(),
        benchmarkApprovedAt: new Date().toISOString(),
      },
    }),
    "unverified",
  ],
  [
    "mechanics approval missing (benchmark only)",
    (row) => ({ ...row, approval: { ...row.approval!, mechanicsApprovedAt: null } }),
    "unreleased",
  ],
  [
    "benchmark approval missing (mechanics only)",
    (row) => ({ ...row, approval: { ...row.approval!, benchmarkApprovedAt: null } }),
    "unreleased",
  ],
  [
    "approval carries an extra key",
    (row) => ({ ...row, approval: { ...row.approval!, actor: "ops" } }),
    "unverified",
  ],
  [
    "canonical bytes drift (trailing newline)",
    (row) => ({ ...row, canonicalDocument: `${String(row.canonicalDocument)}\n` }),
    "unverified",
  ],
  [
    "canonical bytes are the document re-serialised non-canonically",
    (row) => ({ ...row, canonicalDocument: JSON.stringify(row.document, null, 2) }),
    "unverified",
  ],
  [
    "canonical bytes missing",
    (row) => ({ ...row, canonicalDocument: null }),
    "unverified",
  ],
  [
    "document key order changed but bytes untouched (must still verify) — control case",
    (row) => ({
      ...row,
      document: Object.fromEntries(
        Object.entries(row.document as Record<string, unknown>).reverse(),
      ),
    }),
    "ACTIVE",
  ],
  [
    "document tampered after approval (validUntil pushed out)",
    (row) => ({
      ...row,
      document: {
        ...(row.document as AnalysisReleasePolicyDocument),
        validUntil: now() + 10 * 86_400,
      },
    }),
    "unverified",
  ],
  [
    "document tampered AND canonical bytes recomputed (digest still pins the approval)",
    (row) => {
      const doc = {
        ...(row.document as AnalysisReleasePolicyDocument),
        validUntil: now() + 10 * 86_400,
      };
      return { ...row, document: doc, canonicalDocument: canonicalizeOfflineJson(doc) };
    },
    "unverified",
  ],
  [
    "document has an own '__proto__' key",
    (row) => {
      const doc = JSON.parse(String(row.canonicalDocument)) as Record<string, unknown>;
      Object.defineProperty(doc, "__proto__", { value: {}, enumerable: true, configurable: true });
      return { ...row, document: doc };
    },
    "unverified",
  ],
  [
    "supportedInputs empty",
    async () => {
      const doc = policyDocument({ supportedInputs: [] });
      return await activeRow(doc);
    },
    "unverified",
  ],
  [
    "approval sha256 upper-case hex of the right digest",
    (row) => ({
      ...row,
      approval: {
        ...row.approval!,
        policy: {
          ...row.approval!.policy,
          sha256: String(row.approval!.policy.sha256).toUpperCase(),
        },
      },
    }),
    "unverified",
  ],
  [
    "top-level row carries extra keys (forward-compatible) — control case",
    (row) => ({ ...row, installedAt: 1, decisions: [] }),
    "ACTIVE",
  ],
];

for (const [label, mutate, expected] of CORRUPT_ROWS) {
  Deno.test(`ATK-2 permit: ${label} → ${expected === "ACTIVE" ? "reservation proceeds" : `typed 409 ${expected}`}`, async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await mutate(await activeRow());
    const result = await reserve(auth);
    if (expected === "ACTIVE") {
      assertEquals(result.status, 200, JSON.stringify(result.body));
      assertEquals(h.callsTo(RESERVE_RPC).length, 1);
    } else {
      expectTypedRelease(result, expected);
    }
  });
}

Deno.test("ATK-2 permit: oversize canonical bytes (> 65536) → typed 409 unverified", async () => {
  const auth = signIn();
  const doc = policyDocument({ version: `attack-${"v".repeat(120)}` });
  const row = await activeRow(doc);
  // Pad the canonical bytes past the cap while keeping the document intact.
  row.canonicalDocument = `${String(row.canonicalDocument)}${" ".repeat(70_000)}`;
  h.rpcs.read_analysis_release_policy = row;
  expectTypedRelease(await reserve(auth), "unverified");
});

// ── ATK-3 clock boundaries ──────────────────────────────────────────────────

Deno.test("ATK-3 permit: validFrom 30s in the future → typed 409 unreleased", async () => {
  const auth = signIn();
  const t = now();
  const row = await activeRow(policyDocument({ validFrom: t + 30, validUntil: t + 86_400 }));
  row.approval!.mechanicsApprovedAt = t - 60;
  row.approval!.benchmarkApprovedAt = t - 60;
  h.rpcs.read_analysis_release_policy = row;
  expectTypedRelease(await reserve(auth), "unreleased");
});

Deno.test("ATK-3 permit: validUntil == now (closed interval end) → typed 409 expired", async () => {
  const auth = signIn();
  const t = now();
  h.rpcs.read_analysis_release_policy = await activeRow(
    policyDocument({ validFrom: t - 86_400, validUntil: t }),
  );
  expectTypedRelease(await reserve(auth), "expired");
});

Deno.test("ATK-3 permit: validUntil 30s ahead → reservation proceeds (window still open)", async () => {
  const auth = signIn();
  const t = now();
  h.rpcs.read_analysis_release_policy = await activeRow(
    policyDocument({ validFrom: t - 86_400, validUntil: t + 30 }),
  );
  const result = await reserve(auth);
  assertEquals(result.status, 200, JSON.stringify(result.body));
});

Deno.test("ATK-3 permit: approval stamped 30s in the future (edge clock behind DB) → typed 409 unreleased", async () => {
  const auth = signIn();
  const row = await activeRow();
  row.approval!.benchmarkApprovedAt = now() + 30;
  h.rpcs.read_analysis_release_policy = row;
  expectTypedRelease(await reserve(auth), "unreleased");
});

Deno.test("ATK-3 permit: withdrawnAt == now with deny switch still off → typed 409 withdrawn", async () => {
  const auth = signIn();
  const row = await activeRow();
  row.approval!.withdrawnAt = now();
  h.rpcs.read_analysis_release_policy = row;
  expectTypedRelease(await reserve(auth), "withdrawn");
});

Deno.test("ATK-3 permit: withdrawnAt 30s in the future with deny switch off → observed verdict", async () => {
  // The SQL authority sets withdrawn_at = now() AND deny_new_authorizations
  // together (withdraw_analysis_release_policy), so a future withdrawnAt with
  // the switch off can only come from clock skew on a non-active policy or a
  // hand-edited row. Record the verdict: shared rules treat it as scheduled.
  const auth = signIn();
  const row = await activeRow();
  row.approval!.withdrawnAt = now() + 30;
  h.rpcs.read_analysis_release_policy = row;
  const result = await reserve(auth);
  assertEquals(result.status, 200, JSON.stringify(result.body));
});

Deno.test("ATK-3 permit: validUntil beyond year 9999 (253402300800) → typed 409 unverified", async () => {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = await activeRow(
    policyDocument({ validFrom: now() - 60, validUntil: 253_402_300_800 }),
  );
  expectTypedRelease(await reserve(auth), "unverified");
});

Deno.test("ATK-3 permit: negative validFrom → typed 409 unverified", async () => {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = await activeRow(
    policyDocument({ validFrom: -1, validUntil: now() + 60 }),
  );
  expectTypedRelease(await reserve(auth), "unverified");
});

Deno.test("ATK-3 permit: fractional epoch timestamps → typed 409 unverified", async () => {
  const auth = signIn();
  const row = await activeRow();
  row.approval!.mechanicsApprovedAt = now() - 60.5;
  h.rpcs.read_analysis_release_policy = row;
  expectTypedRelease(await reserve(auth), "unverified");
});

Deno.test("ATK-3 sync: scored shot at validUntil == now → typed per-shot rejection, apply never called", async () => {
  const auth = signIn();
  const t = now();
  h.rpcs.read_analysis_release_policy = await activeRow(
    policyDocument({ validFrom: t - 86_400, validUntil: t }),
  );
  const scored = shot("scored");
  const result = await sync(auth, [scored]);
  assertEquals(result.status, 200);
  assertEquals(result.body.rejected.map((r) => [r.id, r.code]), [[scored.id, RELEASE_CODE]]);
  assertEquals(h.callsTo(APPLY_RPC).length, 0);
});

// ── ATK-4 idempotent replay across a withdrawal ─────────────────────────────

Deno.test("ATK-4 permit: same idempotency key twice under an ACTIVE policy → both answered, RPC consulted each time", async () => {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = await activeRow();
  const key = crypto.randomUUID();
  const first = await reserve(auth, key);
  const second = await reserve(auth, key);
  assertEquals(first.status, 200);
  assertEquals(second.status, 200);
  assertEquals(h.callsTo(RESERVE_RPC).length, 2);
  // Each admission re-reads the authority (no memoisation across requests).
  assertEquals(h.callsTo(POLICY_RPC).length, 2);
});

Deno.test("BREAK(P3) ATK-4 permit: reserve succeeded, response lost, policy withdrawn, client retries the SAME key → must learn about its live permit", async () => {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = await activeRow();
  const key = crypto.randomUUID();
  const first = await reserve(auth, key);
  assertEquals(first.status, 200, JSON.stringify(first.body));
  const permitId = (first.body.permit as Record<string, unknown>).id;

  // Operator withdraws the policy between the (lost) response and the retry.
  const row = await activeRow();
  row.denyNewAuthorizations = true;
  row.approval!.denyNewAuthorizations = true;
  row.approval!.withdrawnAt = now();
  h.rpcs.read_analysis_release_policy = row;

  const retry = await reserve(auth, key);
  // The permit is still reserved server-side (reserve_analysis_permit would
  // replay it). A retry with the SAME key is not a new admission: the client
  // needs the permit id to settle/cancel it; otherwise the reservation is
  // invisible to the device until the 24h pg_cron sweep and counts against
  // reserved_count meanwhile.
  assertEquals(
    h.callsTo(RESERVE_RPC).length,
    2,
    `expected the idempotent replay to reach reserve_analysis_permit; got ${retry.status} ${
      JSON.stringify(retry.body)
    }`,
  );
  assertEquals(retry.status, 200);
  assertEquals((retry.body.permit as Record<string, unknown>).id, permitId);
});

// ── ATK-5 free-rating conservation in one mixed batch ───────────────────────

Deno.test("ATK-5 sync: mixed batch (replayed scored, duplicate scored, partial, abstention, malformed) without a policy", async () => {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = NO_POLICY;
  const replayed = shot("scored");
  h.tables.shots = [{ id: replayed.id, user_id: auth.userId }];
  const scored = shot("scored");
  const partial = shot("partial");
  const abstained = shot("low_confidence");
  const malformed = { ...shot("scored"), overallScore: 11 };
  const result = await sync(auth, [replayed, scored, scored, partial, abstained, malformed]);
  assertEquals(result.status, 200, JSON.stringify(result.body));
  assertEquals(result.body.acceptedIds, [replayed.id, partial.id, abstained.id]);
  assertEquals(
    result.body.rejected.map((r) => [r.id, r.code]),
    [
      [malformed.id, "shot.invalid_payload"],
      [scored.id, RELEASE_CODE],
      [scored.id, RELEASE_CODE],
    ],
  );
  const applies = h.callsTo(APPLY_RPC);
  assertEquals(applies.length, 2);
  for (const call of applies) {
    const applied = (call.body as { shot: Record<string, unknown> }).shot;
    assertNotEquals(applied.resultKind, "scored", "no scored settlement without a policy");
    assertEquals(applied.overallScore, null);
    assertNotEquals(call.headers.authorization, SERVICE_BEARER, "apply must run as the user (RLS)");
    // The harness exchanges the ID token for a per-user Supabase session.
    assertEquals(call.headers.authorization, `Bearer session-for-${auth.userId}`);
  }
  assertEquals(h.callsTo(POLICY_RPC).length, 1, "exactly one authority read per batch");
  for (const r of result.body.rejected) {
    assert(!FORBIDDEN_COPY.test(r.message), `copy: ${r.message}`);
  }
});

Deno.test("ATK-5 sync: scored shots for two different users in one process → authority read per batch, never shared", async () => {
  const a = signIn();
  h.rpcs.read_analysis_release_policy = await activeRow();
  const scoredA = shot("scored");
  const resA = await sync(a, [scoredA]);
  assertEquals(resA.body.acceptedIds, [scoredA.id]);
  // Withdraw, then a different user syncs: the earlier ACTIVE verdict must
  // not be reused.
  const row = await activeRow();
  row.denyNewAuthorizations = true;
  row.approval!.denyNewAuthorizations = true;
  h.rpcs.read_analysis_release_policy = row;
  const b = {
    ...a,
    token: fakeGoogleIdToken(`7a010202-0000-4000-8000-${"9".repeat(12)}`),
    ip: "203.0.115.9",
  };
  const scoredB = shot("scored");
  const resB = await sync(b, [scoredB]);
  assertEquals(resB.body.acceptedIds, []);
  assertEquals(resB.body.rejected.map((r) => r.code), [RELEASE_CODE]);
  assertEquals(h.callsTo(APPLY_RPC).length, 1);
});

// ── ATK-6 unauthorised callers / credential separation ──────────────────────

Deno.test("ATK-6 permit: anonymous caller → 401 and NO service-role authority read", async () => {
  signIn();
  const response = await h.handler(
    new Request("http://edge.test/functions/v1/api/v1/analysis-permits", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.114.200" },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    }),
  );
  assertEquals(response.status, 401);
  await response.body?.cancel();
  assertEquals(h.callsTo(POLICY_RPC).length, 0);
  assertEquals(h.callsTo(RESERVE_RPC).length, 0);
});

Deno.test("ATK-6 permit: garbage bearer → 401 and NO service-role authority read", async () => {
  const auth = signIn();
  h.userStatus = 401;
  const response = await h.handler(
    userRequest("POST", "/v1/analysis-permits", {
      token: "not-a-jwt",
      ip: auth.ip,
      body: { idempotencyKey: crypto.randomUUID() },
    }),
  );
  assertEquals(response.status, 401);
  await response.body?.cancel();
  assertEquals(h.callsTo(POLICY_RPC).length, 0);
});

Deno.test("ATK-6 permit: malformed body → 400 before any authority read", async () => {
  const auth = signIn();
  for (
    const body of [{}, { idempotencyKey: "" }, { idempotencyKey: "x".repeat(129) }, {
      idempotencyKey: 7,
    }]
  ) {
    const response = await h.handler(
      userRequest("POST", "/v1/analysis-permits", { token: auth.token, ip: auth.ip, body }),
    );
    assertEquals(response.status, 400, JSON.stringify(body));
    await response.body?.cancel();
  }
  assertEquals(h.callsTo(POLICY_RPC).length, 0);
});

Deno.test("ATK-6 sync: a batch of only malformed shots → no authority read, no apply", async () => {
  const auth = signIn();
  const result = await sync(auth, [{ ...shot("scored"), id: "not-a-uuid" }, {
    ...shot("scored"),
    source: "synthetic",
  }]);
  assertEquals(result.status, 200);
  assertEquals(result.body.acceptedIds, []);
  assertEquals(result.body.rejected.length, 2);
  assertEquals(h.callsTo(POLICY_RPC).length, 0);
  assertEquals(h.callsTo(APPLY_RPC).length, 0);
});

Deno.test("ATK-6 credentials: authority read uses the service role; reserve and apply use the user's bearer", async () => {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = await activeRow();
  const reserved = await reserve(auth);
  assertEquals(reserved.status, 200);
  const synced = await sync(auth, [shot("scored")]);
  assertEquals(synced.body.rejected, []);
  const reads = h.callsTo(POLICY_RPC);
  assertEquals(reads.length, 2);
  for (const read of reads) {
    assertEquals(read.headers.authorization, SERVICE_BEARER);
    assertEquals(read.headers.apikey, "service-role-test-key");
  }
  const chargeable = [...h.callsTo(RESERVE_RPC), ...h.callsTo(APPLY_RPC)];
  assertEquals(chargeable.length, 2);
  for (const call of chargeable) {
    assertEquals(call.headers.authorization, `Bearer session-for-${auth.userId}`);
    assertNotEquals(call.headers.apikey, "service-role-test-key");
  }
});

Deno.test("ATK-6 sync: a client cannot smuggle a release verdict in the shot payload", async () => {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = NO_POLICY;
  const scored = {
    ...shot("scored"),
    release: { status: "eligible" },
    releaseEligibility: "active",
  };
  const result = await sync(auth, [scored]);
  assertEquals(result.status, 200);
  assertEquals(result.body.acceptedIds, []);
  assertEquals(h.callsTo(APPLY_RPC).length, 0);
});

// ── ATK-7 copy ──────────────────────────────────────────────────────────────

Deno.test("ATK-7 copy: typed permit verdict and per-shot rejection follow APP_STORE_SUBMISSION.md", async () => {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = NO_POLICY;
  const permit = await reserve(auth);
  const scored = shot("scored");
  const synced = await sync(auth, [scored]);
  const messages = [
    String((permit.body.error as Record<string, unknown>).message),
    synced.body.rejected[0].message,
  ];
  for (const message of messages) {
    assert(message.length > 0 && message.length <= 200, message);
    assert(!FORBIDDEN_COPY.test(message), `forbidden copy: ${message}`);
    // The verdict must say the rating was NOT counted (free-rating honesty).
    assert(/not counted|was not counted|no rating was counted/i.test(message), message);
  }
});

// ── ATK-8 GET /v1/analysis/release-policy in the production-default state ───

Deno.test("ATK-8 read: GET /v1/analysis/release-policy with nothing installed (production default) → 200 with policy null, not a 5xx", async () => {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = NO_POLICY;
  const response = await h.handler(
    userRequest("GET", "/v1/analysis/release-policy", { token: auth.token, ip: auth.ip }),
  );
  const body = (await response.json()) as Record<string, unknown>;
  // "Nothing installed" is the documented default state of the release
  // authority — a typed non-5xx answer, not an outage, so the mobile policy
  // client (W01-06) can distinguish "no policy" from "authority unreachable".
  assertEquals(response.status, 200, JSON.stringify(body));
  assertEquals(body.policy, null);
  assertEquals(body.schemaVersion, "analysis-release-authority-v1");
});

Deno.test("ATK-8 read: GET /v1/analysis/release-policy with a corrupt row → 503 (read surface), while admission is a typed 409", async () => {
  const auth = signIn();
  const row = await activeRow();
  row.approval!.policy.sha256 = "b".repeat(64);
  h.rpcs.read_analysis_release_policy = row;
  const read = await h.handler(
    userRequest("GET", "/v1/analysis/release-policy", { token: auth.token, ip: auth.ip }),
  );
  await read.body?.cancel();
  assertEquals(read.status, 503);
  expectTypedRelease(await reserve(auth), "unverified");
});
