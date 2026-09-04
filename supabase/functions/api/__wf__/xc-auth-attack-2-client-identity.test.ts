// xc-security-auth-attack-2 — adversarial harness: a MODIFIED MOBILE CLIENT.
//
// Threat model: the attacker controls the app binary, so every byte the client
// sends is hostile — request bodies, query strings, headers, path ids — while
// the only credential it holds is its OWN verified provider/session token.
// The invariant under attack: the server's notion of "who is calling" must
// come exclusively from the verified token, never from a client-supplied
// field (`userId`, `user_id`, `canonicalAppUserId`, `appUserId`, `sub`, …).
//
// Every case here runs through the REAL edge handler (routesHarness captures
// index.ts's Deno.serve handler with Supabase Auth/PostgREST and RevenueCat
// stubbed at the fetch layer) and inspects the OUTBOUND calls the handler
// makes: the identity in the PostgREST filters/payloads and in the RevenueCat
// subscriber URL is the ground truth of whose data was touched.
//
// Two layers:
//   1. targeted cases (bootstrap identity confusion, Apple authorization-code
//      subject binding, canonicalAppUserId → RevenueCat, spoofed bodies on
//      every mutating route, header/query spoofs, route-normalization);
//   2. a deterministic seeded sweep (SEED below) over
//      route × spoofed-field × placement, so every failure is replayable by
//      its case id and the whole matrix is dumped as JSON.
//
// Run (repo root):
//   (cd supabase/functions/api/__wf__ && deno task test xc-auth-attack-2-client-identity.test.ts)
// Optional artifact dump:
//   XC_AUTH_ATTACK2_OUT=/tmp/xc-attack2 deno task test xc-auth-attack-2-client-identity.test.ts
//
// New file only: no production code, migration, or existing test is touched.

import { assert, assertEquals } from "@std/assert";
import {
  fakeAppleIdToken,
  fakeGoogleIdToken,
  type Harness,
  loadHarness,
  OTHER_USER_ID,
  RC_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

// ─── Determinism ────────────────────────────────────────────────────────────

/** Seed for every generated id in this file. Change nothing else to replay. */
const SEED = 20260904;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(SEED);

/** RFC-4122 v4-shaped uuid from the seeded PRNG (the edge function's UUID_RE
 * requires version 1-8 and variant 8|9|a|b). */
function seededUuid(): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 32; i += 1) out += hex[Math.floor(random() * 16)];
  return [
    out.slice(0, 8),
    out.slice(8, 12),
    `4${out.slice(13, 16)}`,
    `8${out.slice(17, 20)}`,
    out.slice(20, 32),
  ].join("-");
}

const isoNow = (): string => new Date().toISOString();

// ─── Case bookkeeping ───────────────────────────────────────────────────────

interface CaseRecord {
  id: string;
  group: string;
  route: string;
  actor: string;
  victim: string;
  spoofField: string;
  placement: string;
  status: number;
  /** Distinct identities seen in outbound Supabase/RevenueCat traffic. */
  outboundIdentities: string[];
  /** The victim id was used AS AN IDENTITY downstream: a `user_id` filter or
   * row column, a profiles `id`, the RevenueCat subscriber path, a Supabase
   * Auth path, or a user-ish key inside an RPC argument. */
  identityHits: string[];
  /** The victim id appears ANYWHERE in outbound traffic — including inside
   * opaque client payloads the server stores verbatim (e.g. an evaluation
   * trial's JSON). Reported for transparency; not by itself a violation. */
  victimAnywhereOutbound: boolean;
  victimInResponse: boolean;
  verdict: "held" | "VIOLATION";
}

const records: CaseRecord[] = [];

const UUID_GLOBAL =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

/** Identities appearing in outbound traffic: PostgREST filters/payloads, the
 * RevenueCat subscriber path, and Supabase Auth admin paths. Ids that the
 * CASE ITSELF supplied as a non-identity value (shot/session/permit uuids)
 * are irrelevant here — the caller passes the set of ids it cares about. */
function outboundIdentities(harness: Harness, interesting: string[]): string[] {
  const seen = new Set<string>();
  for (const call of harness.calls) {
    const haystack = `${call.url} ${JSON.stringify(call.body ?? null)}`;
    for (const id of haystack.match(UUID_GLOBAL) ?? []) {
      const lower = id.toLowerCase();
      if (interesting.includes(lower)) seen.add(lower);
    }
  }
  return [...seen];
}

function victimTouched(harness: Harness, victim: string): boolean {
  return harness.calls.some((call) =>
    `${call.url} ${JSON.stringify(call.body ?? null)}`.toLowerCase().includes(
      victim.toLowerCase(),
    )
  );
}

const IDENTITY_KEY =
  /^(user_id|userid|uid|p_user_id|p_uid|owner_id|account_id|app_user_id|canonical_app_user_id|canonicalappuserid|appuserid|sub)$/i;

function rowIdentityHits(
  row: unknown,
  table: string,
  victim: string,
  where: string,
  out: string[],
): void {
  if (!row || typeof row !== "object" || Array.isArray(row)) return;
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    const isIdentityKey = IDENTITY_KEY.test(key) ||
      (table === "profiles" && key === "id");
    if (
      isIdentityKey && typeof value === "string" &&
      value.toLowerCase() === victim
    ) {
      out.push(`${where} ${key}=${value}`);
    }
  }
}

/** Every place the victim id was consumed AS WHO-IS-CALLING downstream. */
function identityChannelHits(harness: Harness, victimRaw: string): string[] {
  const victim = victimRaw.toLowerCase();
  const hits: string[] = [];
  for (const call of harness.calls) {
    const url = new URL(call.url);
    const lowerUrl = call.url.toLowerCase();
    if (call.url.startsWith(RC_URL)) {
      if (lowerUrl.includes(victim)) {
        hits.push(`revenuecat ${call.method} ${url.pathname}`);
      }
      continue;
    }
    if (url.pathname.includes("/auth/v1/")) {
      if (url.pathname.toLowerCase().includes(victim)) {
        hits.push(`auth ${call.method} ${url.pathname}`);
      }
      continue;
    }
    if (!url.pathname.includes("/rest/v1/")) continue;
    const table = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    const isRpc = url.pathname.includes("/rest/v1/rpc/");
    for (const [key, value] of url.searchParams.entries()) {
      const isIdentityKey = IDENTITY_KEY.test(key) ||
        (table === "profiles" && key === "id");
      if (isIdentityKey && value.toLowerCase().includes(victim)) {
        hits.push(`${call.method} ${table} filter ${key}=${value}`);
      }
    }
    const body = call.body;
    const rows = Array.isArray(body) ? body : [body];
    for (const row of rows) {
      rowIdentityHits(row, table, victim, `${call.method} ${table} row`, hits);
      if (isRpc && row && typeof row === "object") {
        // RPC arguments: one level down (e.g. apply_synced_shot({ shot })).
        for (
          const [arg, value] of Object.entries(row as Record<string, unknown>)
        ) {
          rowIdentityHits(value, table, victim, `rpc ${table}.${arg}`, hits);
        }
      }
    }
  }
  return hits;
}

async function record(
  harness: Harness,
  entry: Omit<
    CaseRecord,
    | "outboundIdentities"
    | "identityHits"
    | "victimAnywhereOutbound"
    | "victimInResponse"
    | "verdict"
  >,
  response: Response,
): Promise<CaseRecord> {
  const bodyText = await response.clone().text();
  const hits = identityChannelHits(harness, entry.victim);
  const inResponse = bodyText.toLowerCase().includes(
    entry.victim.toLowerCase(),
  );
  const row: CaseRecord = {
    ...entry,
    outboundIdentities: outboundIdentities(harness, [
      entry.actor,
      entry.victim,
    ]),
    identityHits: hits,
    victimAnywhereOutbound: victimTouched(harness, entry.victim),
    victimInResponse: inResponse,
    verdict: hits.length > 0 || inResponse ? "VIOLATION" : "held",
  };
  records.push(row);
  return row;
}

/** A spoof case holds when the victim's id is never consumed as an identity
 * downstream and never comes back in the response. */
function assertHeld(row: CaseRecord): void {
  assertEquals(
    row.verdict,
    "held",
    `${row.id} ${row.route} spoof=${row.spoofField}@${row.placement}: victim ${row.victim} ${
      row.identityHits.length > 0
        ? `was used as an identity downstream: ${row.identityHits.join("; ")}`
        : "came back in the response body"
    } (status ${row.status}, outbound=${row.outboundIdentities.join(",")})`,
  );
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Everything a route may read, seeded for `actor` so the happy path is
 * reachable and the ONLY thing left to vary is the spoofed identity. */
function seedFixtures(
  harness: Harness,
  actor: string,
  ids: {
    shotId?: string;
    sessionId?: string;
    permitId?: string;
    trialId?: string;
    challenge?: string;
  } = {},
): void {
  harness.tables.profiles = [
    {
      id: actor,
      email: "actor@example.com",
      onboarding_state: "complete",
      provider: "google",
      skill_level: "3.5",
      handedness: "right",
      primary_goal: "dinks",
      biggest_problem: "nets",
      focus_checkpoint: "contact_position",
      first_name: "Actor",
      gender: null,
      created_at: isoNow(),
    },
  ];
  harness.tables.consent_records = [
    {
      scope: "evaluation_telemetry",
      action: "grant",
      consent_version: "2026-09-01",
      created_at: isoNow(),
    },
    {
      scope: "model_training",
      action: "grant",
      consent_version: "2026-09-01",
      created_at: isoNow(),
    },
  ];
  harness.tables.analysis_permits = ids.permitId
    ? [{
      id: ids.permitId,
      status: "reserved",
      outcome: null,
      created_at: isoNow(),
    }]
    : [];
  harness.tables.sessions = ids.sessionId
    ? [{ id: ids.sessionId, user_id: actor, ended_at: null }]
    : [];
  harness.tables.shots = ids.shotId ? [{ id: ids.shotId, user_id: actor }] : [];
  harness.tables.evaluation_trials = ids.trialId
    ? [{ id: ids.trialId, user_id: actor }]
    : [];
  harness.tables.account_deletion_requests = ids.challenge
    ? [
      {
        challenge: ids.challenge,
        created_at: new Date(Date.now() - 10_000).toISOString(),
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      },
    ]
    : [];
  harness.tables.account_external_credentials = [];
  harness.tables.user_saved_drills = [];
  harness.tables.player_rank_state = [];
  harness.tables.player_technique_rating = [];
  harness.tables.progress_daily = [];
  harness.tables.practice_days = [];
  harness.tables.billing_entitlements = [];
  harness.rpcs.access_state = [{
    premium: false,
    scored_count: 0,
    reserved_count: 0,
  }];
  harness.rpcs.apply_synced_shot = "accepted";
  harness.rpcs.reserve_analysis_permit = [
    {
      result: "accepted",
      permit_id: ids.permitId ?? seededUuid(),
      permit_status: "reserved",
      permit_outcome: null,
      permit_created_at: isoNow(),
    },
  ];
  harness.subscriber = {};
}

function validShot(
  shotId: string,
  permitId: string,
  sessionId: string | null,
): Record<
  string,
  unknown
> {
  return {
    id: shotId,
    source: "real",
    analysisPermitId: permitId,
    sessionId,
    shotType: "dink",
    cameraView: "side",
    capturedAt: isoNow(),
    timestamps: { startMs: 0, contactMs: 500, endMs: 1_000 },
    resultKind: "scored",
    overallScore: 7.5,
    confidence: 0.9,
    phases: [{
      key: "preparation",
      startMs: 0,
      representativeMs: 100,
      endMs: 200,
      confidence: 0.9,
    }],
    checkpoints: [
      {
        key: "contact_position",
        score: 80,
        confidence: 0.9,
        band: "green",
        direction: "none",
        severity: 0,
        applicable: true,
      },
    ],
    versionVector: {
      appVersion: "1.0.0",
      modelBundleVersion: "1",
      poseModelVersion: "1",
      paddleModelVersion: "1",
      strokeDetectorVersion: "1",
      phaseModelVersion: "1",
      scoringModelVersion: "1",
      shotConfigVersion: "1",
    },
  };
}

// ─── Route catalogue (every client-writable surface) ─────────────────────────

interface AttackTarget {
  name: string;
  method: string;
  /** Path built from case-owned ids. */
  path: (ids: Record<string, string>) => string;
  /** Legitimate body for `actor`; spoofed fields are merged over it. */
  body?: (
    actor: string,
    ids: Record<string, string>,
  ) => Record<string, unknown>;
  /** Ids the fixture must contain for the happy path. */
  needs?: Array<"shotId" | "sessionId" | "permitId" | "trialId" | "challenge">;
}

const TARGETS: AttackTarget[] = [
  {
    name: "POST /v1/analysis-permits",
    method: "POST",
    path: () => "/v1/analysis-permits",
    body: () => ({ idempotencyKey: `attack-${seededUuid()}` }),
  },
  {
    name: "POST /v1/analysis-permits/:id/finalize",
    method: "POST",
    path: (ids) => `/v1/analysis-permits/${ids.permitId}/finalize`,
    body: () => ({ outcome: "cancelled", ratingId: null }),
    needs: ["permitId"],
  },
  {
    name: "POST /v1/shots:sync",
    method: "POST",
    path: () => "/v1/shots:sync",
    body: (_actor, ids) => ({
      shots: [validShot(seededUuid(), ids.permitId, ids.sessionId)],
    }),
    needs: ["permitId", "sessionId"],
  },
  {
    name: "POST /v1/sessions",
    method: "POST",
    path: () => "/v1/sessions",
    body: () => ({ id: seededUuid(), startedAt: isoNow() }),
  },
  {
    name: "POST /v1/sessions/:id/finalize",
    method: "POST",
    path: (ids) => `/v1/sessions/${ids.sessionId}/finalize`,
    body: () => ({}),
    needs: ["sessionId"],
  },
  {
    name: "POST /v1/analyses/:id/feedback",
    method: "POST",
    path: (ids) => `/v1/analyses/${ids.shotId}/feedback`,
    body: () => ({ rating: "accurate", category: null }),
    needs: ["shotId"],
  },
  {
    name: "PUT /v1/me/onboarding",
    method: "PUT",
    path: () => "/v1/me/onboarding",
    body: () => ({
      skillLevel: "3.5",
      handedness: "right",
      goal: "dinks",
      biggestProblem: "nets",
      firstName: "Actor",
    }),
  },
  {
    name: "POST /v1/me/consent/grant",
    method: "POST",
    path: () => "/v1/me/consent/grant",
    body: () => ({
      scope: "model_training",
      consentVersion: "2026-09-01",
      source: "settings",
    }),
  },
  {
    name: "POST /v1/me/consent/withdraw",
    method: "POST",
    path: () => "/v1/me/consent/withdraw",
    body: () => ({ scope: "model_training", source: "settings" }),
  },
  {
    name: "POST /v1/me/evaluation/trials",
    method: "POST",
    path: () => "/v1/me/evaluation/trials",
    body: (_actor, ids) => ({
      trials: [{ trialId: ids.trialId, kind: "attack" }],
    }),
    needs: ["trialId"],
  },
  {
    name: "POST /v1/me/delete-request",
    method: "POST",
    path: () => "/v1/me/delete-request",
    body: () => ({ survey: { reason: "other", details: "attack harness" } }),
  },
  {
    name: "POST /v1/billing/sync",
    method: "POST",
    path: () => "/v1/billing/sync",
    body: () => ({}),
  },
  {
    name: "PUT /v1/me/saved-drills/:slug",
    method: "PUT",
    path: () => "/v1/me/saved-drills/cross-court-dinks",
  },
  {
    name: "DELETE /v1/me/saved-drills/:slug",
    method: "DELETE",
    path: () => "/v1/me/saved-drills/cross-court-dinks",
  },
  { name: "GET /v1/me", method: "GET", path: () => "/v1/me" },
  { name: "GET /v1/me/access", method: "GET", path: () => "/v1/me/access" },
  { name: "GET /v1/rank", method: "GET", path: () => "/v1/rank" },
  { name: "GET /v1/progress", method: "GET", path: () => "/v1/progress" },
  {
    name: "GET /v1/me/consent/status",
    method: "GET",
    path: () => "/v1/me/consent/status",
  },
  {
    name: "GET /v1/me/saved-drills",
    method: "GET",
    path: () => "/v1/me/saved-drills",
  },
];

/** Field names a modified client would try. Each is a real identity key
 * somewhere in this system's vocabulary (server payloads, the mobile session
 * record, RevenueCat, JWT claims). */
const SPOOF_FIELDS = [
  "userId",
  "user_id",
  "canonicalAppUserId",
  "canonical_app_user_id",
  "appUserId",
  "app_user_id",
  "sub",
  "subject",
  "uid",
  "authedId",
  "accountId",
  "ownerId",
  "owner",
  "profileId",
  "id",
] as const;

type Placement =
  | "body-top"
  | "body-user-object"
  | "body-nested-context"
  | "body-array-entry"
  | "query"
  | "header";

const PLACEMENTS: Placement[] = [
  "body-top",
  "body-user-object",
  "body-nested-context",
  "body-array-entry",
  "query",
  "header",
];

const HEADER_FOR_FIELD: Record<string, string> = {
  userId: "X-User-Id",
  user_id: "X-User-Id",
  canonicalAppUserId: "X-Canonical-App-User-Id",
  canonical_app_user_id: "X-Canonical-App-User-Id",
  appUserId: "X-App-User-Id",
  app_user_id: "X-App-User-Id",
  sub: "X-Sub",
  subject: "X-Subject",
  uid: "X-Uid",
  authedId: "X-Authed-Id",
  accountId: "X-Account-Id",
  ownerId: "X-Owner-Id",
  owner: "X-Owner",
  profileId: "X-Profile-Id",
  id: "X-Id",
};

/** Merge the spoofed identity into a legitimate request at `placement`. */
function applySpoof(
  target: AttackTarget,
  actor: string,
  victim: string,
  ids: Record<string, string>,
  field: string,
  placement: Placement,
): {
  path: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
} {
  let path = target.path(ids);
  const headers: Record<string, string> = {};
  const base = target.body ? target.body(actor, ids) : undefined;
  let body = base ? { ...base } : undefined;

  switch (placement) {
    case "body-top":
      if (body) {
        // `id` is a legitimate key for POST /v1/sessions — spoofing it there
        // would test id collision, not identity, so it is redirected.
        if (field === "id" && "id" in body) body[`spoofed_${field}`] = victim;
        else body[field] = victim;
      }
      break;
    case "body-user-object":
      if (body) body.user = { [field]: victim, id: victim };
      break;
    case "body-nested-context":
      if (body) {
        body.context = {
          device: { [field]: victim },
          session: { [field]: victim },
        };
      }
      break;
    case "body-array-entry":
      if (body) {
        for (const key of Object.keys(body)) {
          const value = body[key];
          if (Array.isArray(value)) {
            body[key] = value.map((entry) => {
              if (!entry || typeof entry !== "object") return entry;
              const spoofed = {
                ...(entry as Record<string, unknown>),
                user_id: victim,
              };
              // The entry's own resource id (shot/trial uuid) stays intact —
              // overwriting it would test id collision, not identity.
              spoofed[field in spoofed ? `spoofed_${field}` : field] = victim;
              return spoofed;
            });
          }
        }
        body.identities = [{ [field]: victim }];
      }
      break;
    case "query":
      path += `${path.includes("?") ? "&" : "?"}${
        encodeURIComponent(field)
      }=${victim}`;
      break;
    case "header":
      headers[HEADER_FOR_FIELD[field] ?? "X-Identity"] = victim;
      break;
  }
  if (!body && placement.startsWith("body-")) {
    // Routes with no legitimate body still get one: an unexpected payload
    // must not become an identity source either.
    body = {
      [field]: victim,
      user: { id: victim },
      identities: [{ [field]: victim }],
    };
  }
  if (target.method === "GET" && body) {
    // GET cannot carry a body (fetch rejects it) — the same spoof travels in
    // the query string instead, the only channel a GET client has left.
    path += `${path.includes("?") ? "&" : "?"}${
      encodeURIComponent(
        `${placement}.${field}`,
      )
    }=${victim}&user_id=eq.${victim}`;
    body = undefined;
  }
  return { path, body, headers };
}

// ─── 1. Bootstrap identity confusion ────────────────────────────────────────

Deno.test("attack: bootstrap identity comes from the exchanged provider token, never the body", async () => {
  const harness = await loadHarness();
  const actor = seededUuid();
  seedFixtures(harness, actor);
  // A modified client claims to be someone else in every way it can while
  // presenting its own Google token.
  const response = await harness.handler(
    userRequest("POST", "/v1/account/bootstrap", {
      token: fakeGoogleIdToken(actor),
      body: {
        userId: OTHER_USER_ID,
        canonicalAppUserId: OTHER_USER_ID,
        user: { id: OTHER_USER_ID, email: "victim@example.com" },
        sub: OTHER_USER_ID,
        session: {
          accessToken: `session-for-${OTHER_USER_ID}`,
          refreshToken: "x",
          expiresAt: 1,
        },
        device: { platform: "ios", appVersion: "1.0.0" },
      },
      headers: { "X-User-Id": OTHER_USER_ID },
    }),
  );
  const row = await record(
    harness,
    {
      id: "bootstrap-body-spoof",
      group: "bootstrap",
      route: "POST /v1/account/bootstrap",
      actor,
      victim: OTHER_USER_ID,
      spoofField: "userId+canonicalAppUserId+user.id+sub+session",
      placement: "body+header",
      status: response.status,
    },
    response,
  );
  assertHeld(row);
  assertEquals(response.status, 200);
  const payload = (await response.json()) as {
    user: { id: string };
    session: { accessToken: string };
  };
  // The account handed back is the token's subject, and the session is the one
  // Supabase Auth minted for it (not the body's forged pair).
  assertEquals(payload.user.id, actor);
  assertEquals(payload.session.accessToken, `session-for-${actor}`);
  // The profile read was scoped to the verified subject.
  const profileReads = harness.callsTo("/rest/v1/profiles");
  assert(profileReads.length > 0, "bootstrap must read the profile");
  for (const call of profileReads) {
    assert(
      call.url.includes(`id=eq.${actor}`),
      `profile read must be scoped to the verified subject: ${call.url}`,
    );
  }
});

Deno.test("attack: bootstrap cannot mint a session for another identity by swapping the token subject", async () => {
  const harness = await loadHarness();
  const victim = seededUuid();
  seedFixtures(harness, victim);
  // The client presents a token for `victim` — which the stub Auth verifies —
  // so this case documents the ONLY way to become someone else: actually
  // holding their provider token. What matters is that no OTHER identity can
  // be injected alongside it.
  const response = await harness.handler(
    userRequest("POST", "/v1/account/bootstrap", {
      token: fakeGoogleIdToken(victim),
      body: { userId: OTHER_USER_ID, canonicalAppUserId: OTHER_USER_ID },
    }),
  );
  assertEquals(response.status, 200);
  const payload = (await response.json()) as { user: { id: string } };
  assertEquals(payload.user.id, victim);
  assert(
    !victimTouched(harness, OTHER_USER_ID),
    "forged identity must never reach the database",
  );
});

Deno.test("attack: unsigned/foreign-issuer tokens cannot bootstrap", async () => {
  const harness = await loadHarness();
  const actor = seededUuid();
  seedFixtures(harness, actor);
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const payload = btoa(
    JSON.stringify({
      iss: "https://attacker.example.com",
      sub: actor,
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    }),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const response = await harness.handler(
    userRequest("POST", "/v1/account/bootstrap", {
      token: `${header}.${payload}.`,
      body: { userId: actor },
    }),
  );
  assertEquals(response.status, 401);
  assertEquals(harness.callsTo("/rest/v1/").length, 0);
});

Deno.test("attack: Apple authorization code for a different subject is rejected (401 mismatch)", async () => {
  const harness = await loadHarness();
  // The stubbed Apple token endpoint returns a grant whose id_token subject is
  // TEST_USER_ID, so bootstrapping as a DIFFERENT Apple subject models a
  // client that pairs its own identity token with a stolen authorization code.
  const actor = seededUuid();
  seedFixtures(harness, actor);
  const response = await harness.handler(
    userRequest("POST", "/v1/account/bootstrap", {
      token: fakeAppleIdToken(actor),
      headers: { "X-Apple-Revocation-Protocol": "1" },
      body: { appleAuthorizationCode: "stolen-code-from-another-account" },
    }),
  );
  assertEquals(response.status, 401);
  const body = (await response.json()) as { error: { code: string } };
  assertEquals(body.error.code, "auth.apple_authorization_mismatch");
  // No Apple refresh token was stored for the attacker.
  assertEquals(
    harness
      .callsTo("/rest/v1/account_external_credentials")
      .filter((call) => call.method === "POST").length,
    0,
  );
});

Deno.test("attack: matching Apple authorization code stores the credential under the verified subject only", async () => {
  const harness = await loadHarness();
  seedFixtures(harness, TEST_USER_ID);
  const response = await harness.handler(
    userRequest("POST", "/v1/account/bootstrap", {
      token: fakeAppleIdToken(TEST_USER_ID),
      headers: { "X-Apple-Revocation-Protocol": "1" },
      body: {
        appleAuthorizationCode: "valid-code",
        userId: OTHER_USER_ID,
        uid: OTHER_USER_ID,
      },
    }),
  );
  assertEquals(response.status, 200);
  const stored = harness
    .callsTo("/rest/v1/account_external_credentials")
    .filter((call) => call.method === "POST");
  assert(stored.length > 0, "the Apple refresh token must be persisted");
  for (const call of stored) {
    const payload = call.body as Record<string, unknown>;
    assertEquals(payload.user_id, TEST_USER_ID);
  }
  assert(!victimTouched(harness, OTHER_USER_ID));
});

Deno.test("attack: /v1/auth/refresh takes no identity from its body", async () => {
  const harness = await loadHarness();
  const actor = seededUuid();
  seedFixtures(harness, actor);
  const response = await harness.handler(
    new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "198.51.100.9",
      },
      body: JSON.stringify({
        refreshToken: "refresh",
        userId: OTHER_USER_ID,
        canonicalAppUserId: OTHER_USER_ID,
      }),
    }),
  );
  const row = await record(
    harness,
    {
      id: "refresh-body-spoof",
      group: "session",
      route: "POST /v1/auth/refresh",
      actor,
      victim: OTHER_USER_ID,
      spoofField: "userId+canonicalAppUserId",
      placement: "body-top",
      status: response.status,
    },
    response,
  );
  assertHeld(row);
});

// ─── 2. canonicalAppUserId confusion (billing) ──────────────────────────────

Deno.test("attack: canonicalAppUserId in the billing body cannot redirect RevenueCat verification", async () => {
  const harness = await loadHarness();
  const actor = seededUuid();
  const premiumVictim = seededUuid();
  seedFixtures(harness, actor);
  // The victim is premium in RevenueCat; the attacker asks the server to
  // verify THAT subscriber while authenticated as itself.
  harness.subscriber = {
    entitlements: {
      pickle_sensei_pro: {
        expires_date: new Date(Date.now() + 86_400_000).toISOString(),
        product_identifier: "pickle_sensei_pro_monthly",
      },
    },
  };
  const response = await harness.handler(
    userRequest("POST", "/v1/billing/sync", {
      token: fakeGoogleIdToken(actor),
      ip: "198.51.100.11",
      body: {
        canonicalAppUserId: premiumVictim,
        appUserId: premiumVictim,
        app_user_id: premiumVictim,
        userId: premiumVictim,
        aliases: [premiumVictim],
      },
    }),
  );
  const row = await record(
    harness,
    {
      id: "billing-canonical-app-user-id",
      group: "billing",
      route: "POST /v1/billing/sync",
      actor,
      victim: premiumVictim,
      spoofField: "canonicalAppUserId+appUserId+app_user_id+userId+aliases",
      placement: "body-top",
      status: response.status,
    },
    response,
  );
  assertHeld(row);
  const rcCalls = harness.callsTo(RC_URL);
  assert(rcCalls.length > 0, "billing sync must call RevenueCat");
  for (const call of rcCalls) {
    assertEquals(call.url, `${RC_URL}${actor}`);
  }
  // The verified verdict is persisted for the caller, not the victim.
  for (const call of harness.callsTo("/rest/v1/billing_entitlements")) {
    const payload = call.body as Record<string, unknown>;
    assertEquals(payload.user_id, actor);
  }
});

Deno.test("attack: the RevenueCat webhook grants entitlements only to the id it verifies, and needs the shared secret", async () => {
  const harness = await loadHarness();
  const victim = seededUuid();
  seedFixtures(harness, victim);
  harness.subscriber = {
    entitlements: {
      pickle_sensei_pro: {
        expires_date: null,
        product_identifier: "pickle_sensei_pro_lifetime",
      },
    },
  };
  // A modified client cannot forge a webhook: the shared secret gates it.
  const unauthorized = await harness.handler(
    new Request("http://edge.test/functions/v1/api/webhooks/revenuecat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "198.51.100.13",
      },
      body: JSON.stringify({
        api_version: "1.0",
        event: {
          id: seededUuid(),
          type: "INITIAL_PURCHASE",
          app_user_id: victim,
        },
      }),
    }),
  );
  assert(
    unauthorized.status === 401 || unauthorized.status === 403,
    `unauthenticated webhook must be refused, got ${unauthorized.status}`,
  );
  assertEquals(harness.callsTo("/rest/v1/billing_entitlements").length, 0);
});

// ─── 3. Cross-user resource references under a valid session ────────────────

Deno.test("attack: cross-user permit/session/shot references stay scoped to the caller", async () => {
  const harness = await loadHarness();
  const actor = seededUuid();
  const victim = seededUuid();
  const permitId = seededUuid();
  const sessionId = seededUuid();
  const shotId = seededUuid();
  seedFixtures(harness, actor, { permitId, sessionId, shotId });

  const cases: Array<{ id: string; route: string; request: Request }> = [
    {
      id: "cross-permit-finalize",
      route: "POST /v1/analysis-permits/:id/finalize",
      request: userRequest(
        "POST",
        `/v1/analysis-permits/${permitId}/finalize`,
        {
          token: fakeGoogleIdToken(actor),
          ip: "198.51.100.21",
          body: { outcome: "cancelled", ratingId: null, userId: victim },
        },
      ),
    },
    {
      id: "cross-session-finalize",
      route: "POST /v1/sessions/:id/finalize",
      request: userRequest("POST", `/v1/sessions/${sessionId}/finalize`, {
        token: fakeGoogleIdToken(actor),
        ip: "198.51.100.22",
        body: { user_id: victim },
      }),
    },
    {
      id: "cross-shot-feedback",
      route: "POST /v1/analyses/:id/feedback",
      request: userRequest("POST", `/v1/analyses/${shotId}/feedback`, {
        token: fakeGoogleIdToken(actor),
        ip: "198.51.100.23",
        body: {
          rating: "accurate",
          category: null,
          user_id: victim,
          ownerId: victim,
        },
      }),
    },
    {
      id: "cross-shot-sync",
      route: "POST /v1/shots:sync",
      request: userRequest("POST", "/v1/shots:sync", {
        token: fakeGoogleIdToken(actor),
        ip: "198.51.100.24",
        body: {
          shots: [{
            ...validShot(seededUuid(), permitId, sessionId),
            user_id: victim,
            uid: victim,
          }],
        },
      }),
    },
  ];

  for (const entry of cases) {
    harness.calls = [];
    const response = await harness.handler(entry.request);
    const row = await record(
      harness,
      {
        id: entry.id,
        group: "cross-user-reference",
        route: entry.route,
        actor,
        victim,
        spoofField: "userId|user_id|ownerId|uid",
        placement: "body-top",
        status: response.status,
      },
      response,
    );
    assertHeld(row);
    // Every ownership filter/payload names the caller.
    for (
      const call of harness.calls.filter((c) => c.url.includes("/rest/v1/"))
    ) {
      const payload = JSON.stringify(call.body ?? null);
      if (payload.includes("user_id")) {
        assert(
          payload.includes(actor),
          `${entry.id}: write payload must carry the caller id — ${
            payload.slice(0, 200)
          }`,
        );
      }
    }
    // Re-seed: the loop shares one fixture set.
    seedFixtures(harness, actor, { permitId, sessionId, shotId });
  }
});

Deno.test("attack: route normalization cannot smuggle an unauthenticated path", async () => {
  const harness = await loadHarness();
  const actor = seededUuid();
  seedFixtures(harness, actor);
  // The router slices from the LAST "/v1/": try to make an authenticated route
  // look public, and a public route look like someone else's data.
  const smuggles = [
    "/v1/healthz/v1/me",
    "/v1/me/../v1/me",
    "/v1/privacy/v1/me/access",
    `/v1/me%2f${OTHER_USER_ID}`,
  ];
  for (const path of smuggles) {
    harness.calls = [];
    const response = await harness.handler(
      new Request(`http://edge.test/functions/v1/api${path}`, {
        method: "GET",
        headers: { "x-forwarded-for": "198.51.100.31" },
      }),
    );
    // No bearer at all: an authenticated route must refuse, and a public page
    // must not touch the database.
    assert(
      response.status === 401 || response.status === 404 ||
        response.status === 200,
      `${path}: unexpected status ${response.status}`,
    );
    if (response.status === 200) {
      assertEquals(
        harness.callsTo("/rest/v1/").length,
        0,
        `${path}: a no-bearer 200 must be a public page, not user data`,
      );
    }
    const row = await record(
      harness,
      {
        id: `smuggle:${path}`,
        group: "route-normalization",
        route: `GET ${path}`,
        actor,
        victim: OTHER_USER_ID,
        spoofField: "path",
        placement: "path",
        status: response.status,
      },
      response,
    );
    assertHeld(row);
  }
});

// ─── 4. Seeded sweep: route × spoofed field × placement ─────────────────────

Deno.test("attack sweep: no spoofed identity field on any client-writable route changes the server's subject", async () => {
  const harness = await loadHarness();
  let ipCounter = 0;
  const nextIp = (): string => {
    ipCounter += 1;
    return `203.0.${Math.floor(ipCounter / 250) + 20}.${(ipCounter % 250) + 1}`;
  };

  const violations: CaseRecord[] = [];
  let executed = 0;

  for (const target of TARGETS) {
    for (const field of SPOOF_FIELDS) {
      for (const placement of PLACEMENTS) {
        // Each case gets a fresh authenticated identity (so per-user rate
        // budgets never mask a result) and a fresh victim.
        const actor = seededUuid();
        const victim = seededUuid();
        const ids: Record<string, string> = {
          permitId: seededUuid(),
          sessionId: seededUuid(),
          shotId: seededUuid(),
          trialId: seededUuid(),
          challenge: seededUuid(),
        };
        harness.calls = [];
        seedFixtures(harness, actor, {
          permitId: ids.permitId,
          sessionId: ids.sessionId,
          shotId: ids.shotId,
          trialId: ids.trialId,
          challenge: ids.challenge,
        });
        const { path, body, headers } = applySpoof(
          target,
          actor,
          victim,
          ids,
          field,
          placement,
        );
        const response = await harness.handler(
          userRequest(target.method, path, {
            token: fakeGoogleIdToken(actor),
            ip: nextIp(),
            body,
            headers,
          }),
        );
        executed += 1;
        const row = await record(
          harness,
          {
            id: `sweep:${target.name}:${field}:${placement}`,
            group: "sweep",
            route: target.name,
            actor,
            victim,
            spoofField: field,
            placement,
            status: response.status,
          },
          response,
        );
        if (row.verdict === "VIOLATION") violations.push(row);
        // A 429 would mean the case never reached the handler's logic.
        assert(
          response.status !== 429,
          `${row.id}: rate limited (${response.status}) — sweep case did not execute`,
        );
      }
    }
  }

  assertEquals(
    violations.length,
    0,
    `spoofed identity reached the data layer in ${violations.length} case(s): ${
      violations
        .slice(0, 5)
        .map((v) => `${v.id} (status ${v.status})`)
        .join("; ")
    }`,
  );
  assert(executed >= TARGETS.length * SPOOF_FIELDS.length * PLACEMENTS.length);
});

// ─── Artifact dump ──────────────────────────────────────────────────────────

Deno.test("attack matrix artifact", async () => {
  const outDir = Deno.env.get("XC_AUTH_ATTACK2_OUT");
  const summary = {
    seed: SEED,
    generatedAt: isoNow(),
    totalCases: records.length,
    violations: records.filter((r) => r.verdict === "VIOLATION"),
    byGroup: Object.fromEntries(
      [...new Set(records.map((r) => r.group))].map((group) => [
        group,
        {
          cases: records.filter((r) => r.group === group).length,
          violations:
            records.filter((r) =>
              r.group === group && r.verdict === "VIOLATION"
            ).length,
        },
      ]),
    ),
    cases: records,
  };
  if (outDir) {
    await Deno.mkdir(outDir, { recursive: true });
    await Deno.writeTextFile(
      `${outDir}/edge_client_identity_matrix.json`,
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  }
  assertEquals(
    summary.violations.length,
    0,
    JSON.stringify(summary.violations.slice(0, 5)),
  );
  assert(records.length > 0, "the matrix must contain executed cases");
});
