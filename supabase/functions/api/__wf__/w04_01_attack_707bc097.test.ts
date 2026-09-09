/**
 * W04-01 ADVERSARY — attack suite against candidate 707bc097 (offline device
 * registry / grants / append-only allocation ledger).
 *
 * Same harness shape as w04_01_offline_grants_concurrency.test.ts: a
 * disposable postgres:16 with shim_auth.sql + every migration applied
 * (./xc_pg_up.sh), every client statement as role `authenticated` with a JWT
 * sub AND a live auth.sessions row named in request.jwt.claims. Owner-role
 * statements stand in for Supabase Auth / the service and are labelled.
 *
 *   ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json w04_01_attack_707bc097.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
 * ignored run is NOT a pass.
 *
 * Attacks (each is one Deno.test; every assertion names the invariant):
 *   ATK-01 boundary/contract: installation-key alphabet — the wire contract
 *          (edge CLAIM_ID_RE / shared-types isIdentifier) vs the registry.
 *   ATK-02 boundary inputs: every malformed RPC argument answers a verdict,
 *          never raises, never charges (ledger unchanged).
 *   ATK-03 crash between steps / partial persisted state: a consume that
 *          fails at the shot, phase or checkpoint insert leaves NO shot, NO
 *          ledger row, the ticket outstanding and the settlement vouch
 *          cleared; the same ticket then settles a valid shot.
 *   ATK-04 replay / duplicate identities: same ticket+shot replays as
 *          accepted with one shot; same shot under a second ticket, a
 *          stranger's shot id, a consumed ticket with a new shot — none
 *          charges twice.
 *   ATK-05 unauthorised roles: anon / service_role / no API key / no
 *          session / expired session / banned / foreign session on every new
 *          RPC; direct client writes to the four tables and to
 *          shots.offline_ticket_id; owner UPDATE/DELETE on the ledger.
 *   ATK-06 cross-account isolation: a stranger presenting the victim's
 *          installation key or ticket ids; a re-created account under an
 *          UNLINKED identity with the same installation key.
 *   ATK-07 free-rating conservation across online + offline paths (scored +
 *          reserved + held ≤ 2 in every ordering, released tickets stay
 *          counted, a stale permit cannot settle beside two held tickets).
 *   ATK-08 concurrency: overlapping issue/issue (same and different
 *          devices), issue vs reserve_analysis_permit, 8-lane issue burst.
 *   ATK-09 Pro lease boundaries: lifetime / far / near / infinite / lapsed
 *          entitlement — lease ≤ 7 days and ≤ entitlement expiry, no tickets.
 *   ATK-10 registration state machine: attested never downgrades,
 *          environment change refused, unattested device gets no grant.
 *   ATK-11 process death + restart across account deletion: same identity,
 *          same installation — outstanding tickets recovered, consumed ones
 *          not re-credited, lifetime total stays 2.
 */
import postgres, { type JSONValue } from "postgres";
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const RUN = crypto.randomUUID().slice(0, 8);
const U = (n: number): string => `0000000c-0402-4000-8000-${RUN}00${String(n).padStart(2, "0")}`;
const SESSION = (n: number): string =>
  `0000000c-0402-4000-8000-${RUN}0a${String(n).padStart(2, "0")}`;
const KEY = (name: string): string => `${name}-${RUN}`;
const SUB = (name: string): string => `w04-01-atk-${name}-${RUN}`;

/** The installation-key alphabet the shipping edge function accepts in a
 * settlement claim (supabase/functions/api/index.ts CLAIM_ID_RE) and the
 * shared offline authorization types validate (packages/shared-types/src/
 * offlineAuthorization.ts isIdentifier). */
const WIRE_CLAIM_ID_RE = /^[A-Za-z0-9._:/+=-]{1,128}$/;

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
  id: string,
  overrides: Record<string, JSONValue> = {},
): Record<string, JSONValue> {
  return {
    id,
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    startMs: 0,
    contactMs: 100,
    endMs: 200,
    overallScore: 7,
    confidence: 0.9,
    resultKind: "scored",
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

let shotSeq = 0;
function shotId(): string {
  shotSeq += 1;
  return `0000000c-0402-4000-8000-${RUN}5${String(shotSeq).padStart(3, "0")}`;
}

type Identity = { provider: "google" | "apple"; sub: string };

/** Owner role stands in for Supabase Auth. */
async function createUser(sql: Sql, n: number, identities: Identity[]): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${U(n)}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${U(n)}', 'w04-01-atk-${n}-${RUN}@example.com', '{"provider":"${identities[0].provider}"}')`,
  );
  for (const identity of identities) {
    await sql.unsafe(
      `insert into auth.identities (provider, provider_id, user_id, identity_data)
       values ('${identity.provider}', '${identity.sub}', '${U(n)}', '{"sub":"${identity.sub}"}')`,
    );
  }
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${SESSION(n)}', '${U(n)}')`);
}

async function deleteUser(sql: Sql, n: number): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${U(n)}'`);
}

/** Owner role stands in for the edge function's service-role entitlement
 * write (billing_entitlements is written only by the edge function). */
async function setEntitlement(
  sql: Sql,
  n: number,
  premium: boolean,
  expiresAt: string | null,
): Promise<void> {
  const exp = expiresAt === null ? "null" : `'${expiresAt}'::timestamptz`;
  await sql.unsafe(`delete from public.billing_entitlements where user_id = '${U(n)}'`);
  await sql.unsafe(
    `insert into public.billing_entitlements (user_id, premium, expires_at, verified_at, verification_order)
     values ('${U(n)}', ${premium}, ${exp}, now(), 1)`,
  );
}

type Caller = {
  apiKey?: boolean;
  session?: string | null;
  role?: "authenticated" | "anon" | "service_role";
};

async function asUser(tx: Tx, n: number, caller: Caller = {}): Promise<void> {
  if (caller.apiKey !== false) {
    await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
      'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  }
  await tx.unsafe(`set local role ${caller.role ?? "authenticated"}`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${U(n)}'`);
  if (caller.session !== null) {
    await tx.unsafe(
      `set local request.jwt.claims = '{"session_id":"${caller.session ?? SESSION(n)}"}'`,
    );
  }
}

function inTx<T>(
  sql: Sql,
  n: number | null,
  fn: (tx: Tx) => Promise<T>,
  caller: Caller = {},
): Promise<T> {
  return sql.begin(async (tx) => {
    if (n !== null) await asUser(tx as unknown as Tx, n, caller);
    return await fn(tx as unknown as Tx);
  }) as Promise<T>;
}

function barrier(): { gate: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open };
}

function pgError(e: unknown): { code: string; message: string } {
  const err = e as { code?: string; message?: string };
  return { code: err.code ?? "?", message: err.message ?? String(e) };
}

async function expectSqlState(
  what: string,
  fn: () => Promise<unknown>,
  ...codes: string[]
): Promise<void> {
  const err = await assertRejects(fn, Error, undefined, `${what}: must raise`);
  const { code, message } = pgError(err);
  assert(
    codes.includes(code),
    `${what}: expected SQLSTATE ${codes.join("|")}, got ${code} ${message}`,
  );
}

type LaneOutcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

async function burst<T>(
  sql: Sql,
  userFor: (lane: number) => number,
  lanes: number,
  fn: (tx: Tx, lane: number) => Promise<T>,
): Promise<Array<LaneOutcome<T>>> {
  const b = barrier();
  let readyCount = 0;
  let allReadyResolve: () => void = () => {};
  const allReady = new Promise<void>((resolve) => {
    allReadyResolve = resolve;
  });
  const runs = Array.from({ length: lanes }, (_, lane) =>
    inTx(sql, userFor(lane), async (tx) => {
      readyCount += 1;
      if (readyCount === lanes) allReadyResolve();
      await b.gate;
      return await fn(tx, lane);
    })
      .then((value) => ({ ok: true as const, value }))
      .catch((e) => ({ ok: false as const, ...pgError(e) })),
  );
  await allReady;
  b.open();
  return await Promise.all(runs);
}

async function overlap<A, B>(
  sql: Sql,
  a: { n: number; fn: (tx: Tx) => Promise<A> },
  b: { n: number; fn: (tx: Tx) => Promise<B> },
): Promise<{ a: A; b: B | { error: string } }> {
  const parked = barrier();
  const aDone = barrier();
  let aResult: A | undefined;
  let aError: unknown;
  const laneA = inTx(sql, a.n, async (tx) => {
    aResult = await a.fn(tx);
    aDone.open();
    await parked.gate;
  }).catch((e) => {
    aError = e;
    aDone.open();
  });
  await aDone.gate;
  if (aError !== undefined) {
    parked.open();
    await laneA;
    throw aError;
  }
  const laneB = inTx(sql, b.n, b.fn).catch((e) => ({
    error: `${pgError(e).code}:${pgError(e).message}`,
  }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  parked.open();
  await laneA;
  const bResult = await laneB;
  return { a: aResult as A, b: bResult };
}

type Registration = { result: string; device_id: string | null; attestation_state: string | null };
async function register(
  tx: Tx,
  key: string,
  environment: string | null = "production",
  attested: boolean | null = true,
): Promise<Registration> {
  const rows = await tx.unsafe<Registration[]>(
    `select r.result, r.device_id::text as device_id, r.attestation_state
     from public.register_offline_device($1::text, $2::text, $3::boolean) r`,
    [key, environment, attested],
  );
  return rows[0];
}

type Grant = {
  result: string;
  grant_id: string | null;
  generation: number | null;
  entitlement_source: string | null;
  issued_at: string | null;
  expires_at: string | null;
  entitlement_expires_at: string | null;
  ticket_ids: string[] | null;
  lease_seconds: number | null;
};
async function issue(tx: Tx, key: string | null, requested: number | null = 2): Promise<Grant> {
  const rows = await tx.unsafe<Grant[]>(
    `select g.result, g.grant_id::text as grant_id, g.generation, g.entitlement_source,
            g.issued_at::text as issued_at, g.expires_at::text as expires_at,
            g.entitlement_expires_at::text as entitlement_expires_at,
            g.ticket_ids::text[] as ticket_ids,
            extract(epoch from (g.expires_at - g.issued_at))::float8 as lease_seconds
     from public.issue_offline_grant($1::text, $2::integer) g`,
    [key, requested],
  );
  return rows[0];
}

async function consume(tx: Tx, ticket: string | null, payload: JSONValue): Promise<string> {
  // postgres.js serialises a parameter bound to a jsonb cast with
  // JSON.stringify itself, so the value is passed as-is (a string would be
  // double-encoded into a JSON string literal).
  const rows = await tx.unsafe(`select public.consume_offline_ticket($1::uuid, $2::jsonb) as r`, [
    ticket,
    payload,
  ]);
  return String(rows[0].r);
}

async function release(
  tx: Tx,
  ticket: string | null,
  reason: string | null = "unused_ticket_returned",
): Promise<string> {
  const rows = await tx.unsafe(`select public.release_offline_ticket($1::uuid, $2::text) as r`, [
    ticket,
    reason,
  ]);
  return String(rows[0].r);
}

async function reserve(tx: Tx, key: string): Promise<{ result: string; permit_id: string | null }> {
  const rows = await tx.unsafe<{ result: string; permit_id: string | null }[]>(
    `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit($1::text) x`,
    [key],
  );
  return rows[0];
}

async function applySynced(tx: Tx, payload: Record<string, JSONValue>): Promise<string> {
  const rows = await tx.unsafe(`select public.apply_synced_shot($1::jsonb) as r`, [payload]);
  return String(rows[0].r);
}

async function ledger(sql: Sql, ticket: string): Promise<string[]> {
  const rows = await sql.unsafe<{ event: string }[]>(
    `select event from public.offline_allocation_ledger where ticket_id = '${ticket}' order by id`,
  );
  return rows.map((r) => r.event);
}

async function count(sql: Sql, query: string): Promise<number> {
  const rows = await sql.unsafe<{ c: number }[]>(`select count(*)::int as c from (${query}) q`);
  return rows[0].c;
}

async function ledgerRows(sql: Sql): Promise<number> {
  return await count(sql, `select 1 from public.offline_allocation_ledger`);
}

async function accessState(
  sql: Sql,
  n: number,
): Promise<{ premium: boolean; scored_count: number; reserved_count: number }> {
  return await inTx(sql, n, async (tx) => {
    const rows = await tx.unsafe<
      { premium: boolean; scored_count: number; reserved_count: number }[]
    >(`select premium, scored_count, reserved_count from public.access_state()`);
    return rows[0];
  });
}

/** One attested device with `requested` free tickets for user n. */
async function setupUser(
  sql: Sql,
  n: number,
  key: string,
  identities: Identity[] = [{ provider: "google", sub: SUB(`u${n}`) }],
  requested = 2,
): Promise<string[]> {
  await createUser(sql, n, identities);
  return await inTx(sql, n, async (tx) => {
    assertEquals((await register(tx, key)).result, "accepted", "setup: register");
    const g = await issue(tx, key, requested);
    assertEquals(g.result, "accepted", "setup: issue");
    assertEquals(g.ticket_ids?.length ?? 0, requested, "setup: ticket count");
    return g.ticket_ids ?? [];
  });
}

// ---------------------------------------------------------------------------
// ATK-01 — installation key alphabet: wire contract vs registry
// ---------------------------------------------------------------------------
Deno.test({
  name: "W04-01 ATK-01: every installation key the shipping wire contract accepts (edge CLAIM_ID_RE / shared-types isIdentifier) registers; 128 chars accepted, 129 and empty refused as a verdict",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await createUser(sql, 1, [{ provider: "google", sub: SUB("k1") }]);
      const max = "a".repeat(128);
      const over = "a".repeat(129);
      assert(WIRE_CLAIM_ID_RE.test(max) && !WIRE_CLAIM_ID_RE.test(over));
      await inTx(sql, 1, async (tx) => {
        assertEquals((await register(tx, max)).result, "accepted", "128-char key");
        assertEquals((await register(tx, over)).result, "offline.invalid_input", "129-char key");
        assertEquals((await register(tx, "")).result, "offline.invalid_input", "empty key");
        assertEquals((await register(tx, "a b")).result, "offline.invalid_input", "space");
        assertEquals((await register(tx, "ä")).result, "offline.invalid_input", "non-ascii");
      });

      // Keys a shipping client may legitimately present under the wire
      // contract (base64url / base64 / path-like / dotted) — a device whose
      // installation key is any of these can never register.
      const wireValid = [
        `AAAA/BBBB-${RUN}`,
        `AAAA+BBBB-${RUN}`,
        `AAAABBBB=-${RUN}`,
        `.dotted-${RUN}`,
        `-dashed-${RUN}`,
        `:colon-${RUN}`,
      ];
      for (const k of wireValid) assert(WIRE_CLAIM_ID_RE.test(k), `${k} is wire-valid`);
      const refused: string[] = [];
      await inTx(sql, 1, async (tx) => {
        for (const k of wireValid) {
          const r = await register(tx, k);
          if (r.result !== "accepted") refused.push(`${k} → ${r.result}`);
        }
      });
      assertEquals(
        refused,
        [],
        "registry must accept every installation key the wire contract (CLAIM_ID_RE) accepts",
      );
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATK-02 — boundary inputs never raise, never charge
// ---------------------------------------------------------------------------
Deno.test({
  name: "W04-01 ATK-02: malformed arguments to every RPC answer a verdict (never raise) and the ledger is unchanged — negative/over-max/null ticket counts, non-object/array/scalar shots, unknown ticket, bad session, non-scored kinds, foreign release reasons",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const key = KEY("atk02");
      const [t1, t2] = await setupUser(sql, 2, key);
      const before = await ledgerRows(sql);
      const scoredBefore = await count(sql, `select 1 from public.shots where user_id = '${U(2)}'`);

      await inTx(sql, 2, async (tx) => {
        // register
        assertEquals((await register(tx, key, "staging", true)).result, "offline.invalid_input");
        assertEquals((await register(tx, key, null, true)).result, "offline.invalid_input");
        assertEquals((await register(tx, key, "production", null)).result, "offline.invalid_input");
        assertEquals(
          (await register(tx, null, "production", true)).result,
          "offline.invalid_input",
        );
        // issue
        assertEquals((await issue(tx, key, -1)).result, "offline.invalid_input", "negative");
        assertEquals((await issue(tx, key, 3)).result, "offline.invalid_input", "over max");
        assertEquals((await issue(tx, key, 2147483647)).result, "offline.invalid_input", "int max");
        assertEquals((await issue(tx, key, null)).result, "offline.invalid_input", "null count");
        assertEquals((await issue(tx, null, 1)).result, "offline.invalid_input", "null key");
        assertEquals(
          (await issue(tx, KEY("never-registered"), 1)).result,
          "offline.device_not_registered",
        );
        const rowsBeforeZero = await tx.unsafe(
          `select 1 from public.offline_allocation_ledger where user_id = '${U(2)}'`,
        );
        const zero = await issue(tx, key, 0);
        assertEquals(zero.result, "accepted", "zero tickets is a valid request");
        assertEquals(
          zero.ticket_ids?.slice().sort(),
          [t1, t2].sort(),
          "zero requested reports the outstanding tickets and allocates nothing new",
        );
        assertEquals(
          (
            await tx.unsafe(
              `select 1 from public.offline_allocation_ledger where user_id = '${U(2)}'`,
            )
          ).length,
          rowsBeforeZero.length,
        );
        // consume
        assertEquals(await consume(tx, null, shotPayload(shotId())), "offline.invalid_input");
        assertEquals(await consume(tx, t1, null), "offline.invalid_input", "null shot");
        assertEquals(await consume(tx, t1, []), "offline.invalid_input", "array shot");
        assertEquals(await consume(tx, t1, "scored"), "offline.invalid_input", "string shot");
        assertEquals(await consume(tx, t1, 7), "offline.invalid_input", "number shot");
        assertEquals(await consume(tx, t1, {}), "offline.invalid_input", "empty object");
        assertEquals(
          await consume(tx, t1, shotPayload(shotId(), { id: "not-a-uuid" })),
          "offline.invalid_input",
          "bad shot id",
        );
        assertEquals(
          await consume(tx, t1, shotPayload(shotId(), { id: null })),
          "offline.invalid_input",
          "null shot id",
        );
        assertEquals(
          await consume(tx, t1, shotPayload(shotId(), { sessionId: "nope" })),
          "offline.invalid_input",
          "bad session id",
        );
        assertEquals(
          await consume(tx, t1, shotPayload(shotId(), { sessionId: crypto.randomUUID() })),
          "shot.session_not_found",
          "unknown session",
        );
        for (const kind of ["partial", "low_confidence", "failed", "withheld", "", null, 1]) {
          assertEquals(
            await consume(tx, t1, shotPayload(shotId(), { resultKind: kind })),
            "offline.shot_not_chargeable",
            `resultKind ${JSON.stringify(kind)} never charges`,
          );
        }
        assertEquals(
          await consume(tx, crypto.randomUUID(), shotPayload(shotId())),
          "offline.ticket_not_found",
        );
        // release
        assertEquals(await release(tx, null), "offline.invalid_input");
        assertEquals(await release(tx, t1, null), "offline.invalid_input");
        assertEquals(await release(tx, t1, ""), "offline.invalid_input");
        assertEquals(
          await release(tx, t1, "support_review"),
          "offline.invalid_input",
          "support_review is not client-assertable",
        );
        assertEquals(await release(tx, t1, "UNUSED_TICKET_RETURNED"), "offline.invalid_input");
        assertEquals(await release(tx, crypto.randomUUID()), "offline.ticket_not_found");
      });

      assertEquals(await ledgerRows(sql), before, "no malformed call appends to the ledger");
      assertEquals(
        await count(sql, `select 1 from public.shots where user_id = '${U(2)}'`),
        scoredBefore,
        "no malformed call writes a shot",
      );
      assertEquals(await ledger(sql, t1), ["allocated"], "ticket still outstanding");
      await inTx(sql, 2, async (tx) => {
        assertEquals(await consume(tx, t1, shotPayload(shotId())), "accepted", "still consumable");
      });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATK-03 — crash between steps: partial write must roll back entirely
// ---------------------------------------------------------------------------
Deno.test({
  name: "W04-01 ATK-03: a consume that fails at the shot / phase / checkpoint insert (NaN score, int overflow, out-of-range clock, bad enum) answers shot.write_failed:<SQLSTATE>, writes no shot and no ledger row, clears the settlement vouch, and the ticket then settles a valid shot",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const key = KEY("atk03");
      const [t1, t2] = await setupUser(sql, 3, key);
      const before = await ledgerRows(sql);

      const poison: Array<[string, Record<string, JSONValue>]> = [
        ["NaN score", { overallScore: "NaN" }],
        ["score > 10", { overallScore: 11 }],
        ["negative score", { overallScore: -1 }],
        ["startMs int overflow", { startMs: 2147483648 }],
        ["capturedAt before 2000", { capturedAt: "1999-12-31T23:59:59.000Z" }],
        ["capturedAt infinity", { capturedAt: "infinity" }],
        ["capturedAt far future", { capturedAt: "2101-01-01T00:00:00.000Z" }],
        ["bad camera view", { cameraView: "overhead" }],
        ["confidence > 1", { confidence: 1.5 }],
        [
          "phase int overflow",
          {
            phases: [
              { key: "load", startMs: 99999999999, representativeMs: 1, endMs: 1, confidence: 0.5 },
            ],
          },
        ],
        [
          "phase key too long",
          {
            phases: [
              { key: "k".repeat(65), startMs: 0, representativeMs: 1, endMs: 1, confidence: 0.5 },
            ],
          },
        ],
        ["phase missing required field", { phases: [{ key: "load", startMs: 0, endMs: 1 }] }],
        [
          "checkpoint bad band",
          {
            checkpoints: [
              {
                key: "elbow",
                score: 50,
                confidence: 0.5,
                band: "purple",
                direction: "up",
                severity: 0.1,
                applicable: true,
              },
            ],
          },
        ],
        [
          "checkpoint severity out of range",
          {
            checkpoints: [
              {
                key: "elbow",
                score: 50,
                confidence: 0.5,
                band: "green",
                direction: "up",
                severity: 7,
                applicable: true,
              },
            ],
          },
        ],
        [
          "checkpoint applicable not boolean",
          {
            checkpoints: [
              {
                key: "elbow",
                score: 50,
                confidence: 0.5,
                band: "green",
                direction: "up",
                severity: 0.1,
                applicable: "maybe",
              },
            ],
          },
        ],
      ];

      const outcomes: string[] = [];
      for (const [label, overrides] of poison) {
        const id = shotId();
        const r = await inTx(sql, 3, async (tx) => {
          const verdict = await consume(tx, t1, shotPayload(id, overrides));
          // Inside the SAME transaction the vouch must be gone: a direct
          // scored insert may not ride on the failed consume.
          await expectSqlState(
            `${label}: direct scored insert after failed consume`,
            () =>
              tx.savepoint((sp) =>
                sp.unsafe(
                  `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind, offline_ticket_id)
                   values ('${shotId()}', '${U(3)}', 'dink', 'side', '2026-09-01T10:00:00Z', 0, 100, 200, 7, 0.9, 'scored', '${t1}')`,
                ),
              ),
            "42501",
          );
          return verdict;
        });
        outcomes.push(`${label} → ${r}`);
        assertMatch(r, /^shot\.write_failed:[0-9A-Z]{5}$/, `${label}: ${r}`);
        assertEquals(
          await count(sql, `select 1 from public.shots where id = '${id}'`),
          0,
          `${label}: no shot persisted`,
        );
      }
      assertEquals(await ledgerRows(sql), before, `no partial write appended (${outcomes})`);
      assertEquals(await ledger(sql, t1), ["allocated"], "ticket still outstanding");
      assertEquals(
        await count(
          sql,
          `select 1 from public.shot_phases p join public.shots s on s.id = p.shot_id where s.user_id = '${U(3)}'`,
        ),
        0,
        "no orphan phases",
      );

      // Same ticket now settles a valid shot with details, once.
      const good = shotId();
      await inTx(sql, 3, async (tx) => {
        assertEquals(
          await consume(
            tx,
            t1,
            shotPayload(good, {
              phases: [
                { key: "load", startMs: 0, representativeMs: 25, endMs: 50, confidence: 0.8 },
              ],
              checkpoints: [
                {
                  key: "elbow",
                  score: 50,
                  confidence: 0.5,
                  band: "green",
                  direction: "up",
                  severity: 0.1,
                  applicable: true,
                },
              ],
            }),
          ),
          "accepted",
        );
      });
      assertEquals(await ledger(sql, t1), ["allocated", "consumed"]);
      assertEquals(
        await count(sql, `select 1 from public.shot_phases where shot_id = '${good}'`),
        1,
      );
      assertEquals(
        await count(sql, `select 1 from public.shot_checkpoints where shot_id = '${good}'`),
        1,
      );
      assertEquals(await ledger(sql, t2), ["allocated"], "sibling ticket untouched");
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATK-03b — NaN through the detail rows: the shot row refuses NaN
// (range checks), but shot_phases.confidence / shot_checkpoints.confidence
// are numeric(5,4) with NO range check, so `"NaN"` casts and persists.
// ---------------------------------------------------------------------------
Deno.test({
  name: "W04-01 ATK-03b: a phase or checkpoint confidence of NaN is refused by consume_offline_ticket() — no detail row with a NaN confidence is ever persisted for a settled ticket",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const key = KEY("atk03b");
      const [t1, t2] = await setupUser(sql, 33, key);
      const cases: [string, string, Record<string, JSONValue>][] = [
        [
          "phase confidence NaN",
          t1,
          {
            phases: [{ key: "load", startMs: 0, representativeMs: 1, endMs: 1, confidence: "NaN" }],
          },
        ],
        [
          "checkpoint confidence NaN",
          t2,
          {
            checkpoints: [
              {
                key: "elbow",
                score: 50,
                confidence: "NaN",
                band: "green",
                direction: "up",
                severity: 0.1,
                applicable: true,
              },
            ],
          },
        ],
      ];
      const observed: string[] = [];
      for (const [label, ticket, overrides] of cases) {
        const id = shotId();
        const verdict = await inTx(sql, 33, (tx) =>
          consume(tx, ticket, shotPayload(id, overrides)),
        );
        const nanRows = await count(
          sql,
          `select 1 from public.shot_phases where shot_id = '${id}' and confidence = 'NaN'::numeric
           union all
           select 1 from public.shot_checkpoints where shot_id = '${id}' and confidence = 'NaN'::numeric`,
        );
        observed.push(
          `${label} → ${verdict}, nan detail rows=${nanRows}, ledger=${await ledger(sql, ticket)}`,
        );
      }
      assertEquals(
        observed.filter(
          (o) => !/→ shot\.write_failed:[0-9A-Z]{5}, nan detail rows=0, ledger=allocated$/.test(o),
        ),
        [],
        "a NaN confidence must fail the settlement atomically, not be persisted beside a consumed ticket",
      );
    } finally {
      await deleteUser(sql, 33);
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATK-04 — replay / duplicate identities
// ---------------------------------------------------------------------------
Deno.test({
  name: "W04-01 ATK-04: replays never charge twice — same ticket+shot replays accepted (one shot, one consumed); same shot id under a second ticket refused and the second ticket stays outstanding; a stranger's shot id is refused; a consumed ticket with a new shot is refused",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const [t1, t2] = await setupUser(sql, 4, KEY("atk04"));
      const [s1] = await setupUser(sql, 5, KEY("atk04-stranger"), undefined, 1);
      const strangerShot = shotId();
      await inTx(sql, 5, async (tx) => {
        assertEquals(await consume(tx, s1, shotPayload(strangerShot)), "accepted");
      });

      const shot = shotId();
      await inTx(sql, 4, async (tx) => {
        assertEquals(await consume(tx, t1, shotPayload(shot)), "accepted", "first settle");
        assertEquals(await consume(tx, t1, shotPayload(shot)), "accepted", "same-tx replay");
      });
      for (let i = 0; i < 3; i += 1) {
        await inTx(sql, 4, async (tx) => {
          assertEquals(await consume(tx, t1, shotPayload(shot)), "accepted", `replay ${i}`);
          assertEquals(
            await consume(tx, t1, shotPayload(shot, { overallScore: 9 })),
            "accepted",
            "replay with a different body is still the same settlement (id-keyed)",
          );
        });
      }
      assertEquals(await ledger(sql, t1), ["allocated", "consumed"], "one consumed event");
      assertEquals(await count(sql, `select 1 from public.shots where id = '${shot}'`), 1);
      assertEquals(
        await count(sql, `select 1 from public.shots where offline_ticket_id = '${t1}'`),
        1,
      );

      await inTx(sql, 4, async (tx) => {
        assertEquals(
          await consume(tx, t2, shotPayload(shot)),
          "offline.shot_not_chargeable",
          "the same shot may not be paid for by a second ticket",
        );
        assertEquals(
          await consume(tx, t2, shotPayload(strangerShot)),
          "shot.id_conflict",
          "a stranger's shot id",
        );
        assertEquals(
          await consume(tx, t1, shotPayload(shotId())),
          "offline.ticket_consumed",
          "consumed ticket, new shot",
        );
        assertEquals(await release(tx, t1), "offline.ticket_consumed", "consumed ticket, release");
      });
      assertEquals(await ledger(sql, t2), ["allocated"], "t2 still outstanding after refusals");
      assertEquals(
        await count(sql, `select 1 from public.shots where user_id = '${U(4)}'`),
        1,
        "exactly one shot for the whole replay storm",
      );
      const own = await count(
        sql,
        `select 1 from public.shots where user_id = '${U(4)}' and result_kind = 'scored'`,
      );
      assertEquals(own, 1);
      const id2 = shotId();
      await inTx(sql, 4, async (tx) => {
        assertEquals(
          await consume(tx, t2, shotPayload(id2)),
          "accepted",
          "t2 settles its own shot",
        );
        assertEquals(await release(tx, t2), "offline.ticket_consumed");
      });
      assertEquals((await accessState(sql, 4)).scored_count, 2, "two ratings for two tickets");
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATK-05 — unauthorised roles / denied writes
// ---------------------------------------------------------------------------
Deno.test({
  name: "W04-01 ATK-05: anon, service_role, no API key, no/expired/foreign session and banned callers are refused on every new RPC (42501, no row); direct client INSERT/UPDATE/DELETE on the four tables and a client-set shots.offline_ticket_id are refused; owner UPDATE/DELETE on the ledger and UPDATE on grants are refused; SELECT is own-rows-only and API-only",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const key = KEY("atk05");
      const [t1] = await setupUser(sql, 6, key);
      await createUser(sql, 7, [{ provider: "google", sub: SUB("u7") }]);
      const before = await ledgerRows(sql);

      const rpcs: Array<[string, (tx: Tx) => Promise<unknown>]> = [
        ["register", (tx) => register(tx, KEY("atk05-x"))],
        ["issue", (tx) => issue(tx, key, 1)],
        ["consume", (tx) => consume(tx, t1, shotPayload(shotId()))],
        ["release", (tx) => release(tx, t1)],
      ];

      const deniedCallers: Array<[string, Caller]> = [
        ["anon", { role: "anon" }],
        ["service_role", { role: "service_role" }],
        ["no API key", { apiKey: false }],
        ["no session claim", { session: null }],
        ["foreign session", { session: SESSION(7) }],
        ["unknown session", { session: crypto.randomUUID() }],
        ["malformed session", { session: "not-a-uuid" }],
      ];
      for (const [who, caller] of deniedCallers) {
        for (const [name, fn] of rpcs) {
          await expectSqlState(`${who} → ${name}`, () => inTx(sql, 6, fn, caller), "42501");
        }
      }

      // expired session
      await sql.unsafe(
        `update auth.sessions set not_after = now() - interval '1 second' where id = '${SESSION(6)}'`,
      );
      for (const [name, fn] of rpcs) {
        await expectSqlState(`expired session → ${name}`, () => inTx(sql, 6, fn), "42501");
      }
      await sql.unsafe(`update auth.sessions set not_after = null where id = '${SESSION(6)}'`);
      // banned user
      await sql.unsafe(
        `update auth.users set banned_until = now() + interval '1 day' where id = '${U(6)}'`,
      );
      for (const [name, fn] of rpcs) {
        await expectSqlState(`banned → ${name}`, () => inTx(sql, 6, fn), "42501");
      }
      await sql.unsafe(`update auth.users set banned_until = null where id = '${U(6)}'`);

      const device = await sql.unsafe<{ id: string }[]>(
        `select id::text as id from public.offline_devices where user_id = '${U(6)}'`,
      );
      const grant = await sql.unsafe<{ id: string }[]>(
        `select id::text as id from public.offline_grants where user_id = '${U(6)}'`,
      );
      assertEquals(device.length, 1);
      assertEquals(grant.length, 1);

      // Direct client writes (own rows, with API key + session) are refused.
      const writes: Array<[string, string]> = [
        [
          "insert device",
          `insert into public.offline_devices (user_id, installation_key_id, attestation_environment, attestation_state, attested_at)
           values ('${U(6)}', '${KEY("atk05-direct")}', 'production', 'attested', now())`,
        ],
        [
          "update device",
          `update public.offline_devices set attestation_state = 'attested', attested_at = now() where id = '${device[0].id}'`,
        ],
        ["delete device", `delete from public.offline_devices where id = '${device[0].id}'`],
        [
          "insert grant",
          `insert into public.offline_grants (user_id, device_id, generation, entitlement_source, issued_at, expires_at)
           values ('${U(6)}', '${device[0].id}', 99, 'identity_lifetime_free', now(), now() + interval '1 day')`,
        ],
        [
          "update grant",
          `update public.offline_grants set expires_at = now() + interval '30 days' where id = '${grant[0].id}'`,
        ],
        ["delete grant", `delete from public.offline_grants where id = '${grant[0].id}'`],
        [
          "insert ledger allocated",
          `insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, installation_key_id)
           values ('${U(6)}', '${device[0].id}', '${grant[0].id}', 1, '${crypto.randomUUID()}', 'allocated', '${key}')`,
        ],
        [
          "insert ledger released",
          `insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, installation_key_id)
           values ('${U(6)}', '${device[0].id}', '${grant[0].id}', 1, '${t1}', 'released', 'support_review', '${key}')`,
        ],
        [
          "update ledger",
          `update public.offline_allocation_ledger set event = 'released', reason = 'x' where ticket_id = '${t1}'`,
        ],
        ["delete ledger", `delete from public.offline_allocation_ledger where ticket_id = '${t1}'`],
        [
          "insert identity link",
          `insert into public.offline_allocation_identity_links (ticket_id, identity_hash) values ('${t1}', 'h')`,
        ],
        ["select identity links", `select * from public.offline_allocation_identity_links`],
        [
          "insert shot with offline_ticket_id",
          `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind, offline_ticket_id)
           values ('${shotId()}', '${U(6)}', 'dink', 'side', '2026-09-01T10:00:00Z', 0, 100, 200, 7, 0.9, 'scored', '${t1}')`,
        ],
        [
          "insert unscored shot with offline_ticket_id",
          `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind, offline_ticket_id)
           values ('${shotId()}', '${U(6)}', 'dink', 'side', '2026-09-01T10:00:00Z', 0, 100, 200, null, 0.9, 'low_confidence', '${t1}')`,
        ],
        [
          "set vouch then insert scored shot",
          `select set_config('pickle.offline_ticket_id', '${t1}', true);
           insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind)
           values ('${shotId()}', '${U(6)}', 'dink', 'side', '2026-09-01T10:00:00Z', 0, 100, 200, 7, 0.9, 'scored')`,
        ],
      ];
      for (const [label, statement] of writes) {
        for (const [who, caller] of [
          ["owner-of-row authenticated", {}],
          ["other authenticated", {}],
          ["anon", { role: "anon" }],
          ["service_role", { role: "service_role" }],
        ] as Array<[string, Caller]>) {
          const n = who === "other authenticated" ? 7 : 6;
          await expectSqlState(
            `${who}: ${label}`,
            () => inTx(sql, n, (tx) => tx.unsafe(statement), caller),
            "42501",
            "23514",
            "42P01",
          );
        }
      }

      // Owner role (postgres / supabase_admin stand-in): the ledger is
      // append-only for EVERY role; grants are immutable.
      await expectSqlState(
        "owner update ledger",
        () =>
          sql.unsafe(
            `update public.offline_allocation_ledger set reason = 'x' where ticket_id = '${t1}'`,
          ),
        "23514",
      );
      await expectSqlState(
        "owner delete ledger",
        () => sql.unsafe(`delete from public.offline_allocation_ledger where ticket_id = '${t1}'`),
        "23514",
      );
      await expectSqlState(
        "owner update grant",
        () =>
          sql.unsafe(
            `update public.offline_grants set expires_at = now() + interval '30 days' where id = '${grant[0].id}'`,
          ),
        "23514",
      );
      await expectSqlState(
        "owner second terminal event",
        () =>
          sql
            .unsafe(
              `insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, installation_key_id)
             select user_id, device_id, grant_id, generation, ticket_id, 'released', 'support_review', installation_key_id
             from public.offline_allocation_ledger where ticket_id = '${t1}' and event = 'allocated'`,
            )
            .then(() =>
              sql.unsafe(
                `insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id, installation_key_id)
             select user_id, device_id, grant_id, generation, ticket_id, 'consumed', '${crypto.randomUUID()}', installation_key_id
             from public.offline_allocation_ledger where ticket_id = '${t1}' and event = 'allocated'`,
              ),
            ),
        "23505",
        "23514",
      );
      // (the owner-written support_review release above is the ONE sanctioned
      // non-RPC ledger write; it counts as terminal for the rest of the test)

      // Reads: own rows with API key; nothing without; nothing of others.
      const ownRows = await inTx(sql, 6, (tx) =>
        tx.unsafe(`select 1 from public.offline_allocation_ledger`),
      );
      assert(ownRows.length >= 2, "owner sees own ledger rows through the API");
      for (const table of ["offline_devices", "offline_grants", "offline_allocation_ledger"]) {
        assertEquals(
          (await inTx(sql, 7, (tx) => tx.unsafe(`select 1 from public.${table}`))).length,
          0,
          `other user sees no ${table} rows`,
        );
        assertEquals(
          (
            await inTx(sql, 6, (tx) => tx.unsafe(`select 1 from public.${table}`), {
              apiKey: false,
            })
          ).length,
          0,
          `no API key sees no ${table} rows`,
        );
        await expectSqlState(
          `anon select ${table}`,
          () => inTx(sql, 6, (tx) => tx.unsafe(`select 1 from public.${table}`), { role: "anon" }),
          "42501",
        );
        await expectSqlState(
          `service_role select ${table}`,
          () =>
            inTx(sql, 6, (tx) => tx.unsafe(`select 1 from public.${table}`), {
              role: "service_role",
            }),
          "42501",
        );
      }
      // Counting functions answer zero without API proof.
      const noApi = await inTx(
        sql,
        6,
        async (tx) => {
          const r = await tx.unsafe<{ h: number }[]>(`select public.offline_hold_count() as h`);
          return r[0].h;
        },
        { apiKey: false },
      );
      assertEquals(noApi, 0, "offline_hold_count() without API proof is 0");
      assertEquals(await ledgerRows(sql), before + 1, "only the owner support_review row landed");
      assertEquals(
        await count(sql, `select 1 from public.shots where user_id = '${U(6)}'`),
        0,
        "no denied write persisted a shot",
      );
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATK-06 — cross-account isolation
// ---------------------------------------------------------------------------
Deno.test({
  name: "W04-01 ATK-06: a stranger presenting the victim's installation key gets their own device and never the victim's tickets; the victim's ticket ids are ticket_not_found to the stranger; a re-created account under an UNLINKED identity with the same installation key recovers nothing and cannot settle the old tickets",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const key = KEY("atk06-shared");
      const [v1, v2] = await setupUser(sql, 8, key);
      const victimHolds = await ledgerRows(sql);

      await createUser(sql, 9, [{ provider: "apple", sub: SUB("u9") }]);
      await inTx(sql, 9, async (tx) => {
        const r = await register(tx, key);
        assertEquals(r.result, "accepted", "stranger registers the same installation key");
        const g = await issue(tx, key, 2);
        assertEquals(g.result, "accepted");
        assertEquals(g.ticket_ids?.length, 2, "stranger allocates from OWN budget");
        assert(!g.ticket_ids!.includes(v1) && !g.ticket_ids!.includes(v2), "never the victim's");
        assertEquals(await consume(tx, v1, shotPayload(shotId())), "offline.ticket_not_found");
        assertEquals(await release(tx, v1), "offline.ticket_not_found");
        assertEquals(await release(tx, v2), "offline.ticket_not_found");
      });
      assertEquals(await ledger(sql, v1), ["allocated"]);
      assertEquals(await ledger(sql, v2), ["allocated"]);
      assertEquals(
        await count(
          sql,
          `select 1 from public.offline_devices where installation_key_id = '${key}'`,
        ),
        2,
        "one device row per (user, key)",
      );
      assertEquals(await ledgerRows(sql), victimHolds + 2);

      // Victim deletes the account; a NEW, unlinked identity signs in on the
      // same installation and asks for tickets.
      await deleteUser(sql, 8);
      await createUser(sql, 10, [{ provider: "google", sub: SUB("u10-unlinked") }]);
      await inTx(sql, 10, async (tx) => {
        assertEquals((await register(tx, key)).result, "accepted");
        const g = await issue(tx, key, 2);
        assertEquals(g.result, "accepted");
        assertEquals(g.ticket_ids?.length, 2, "fresh identity: fresh allocation");
        assert(!g.ticket_ids!.includes(v1) && !g.ticket_ids!.includes(v2), "no recovery");
        assertEquals(await consume(tx, v1, shotPayload(shotId())), "offline.ticket_not_found");
        assertEquals(await release(tx, v2), "offline.ticket_not_found");
        const h = await tx.unsafe<{ h: number }[]>(`select public.offline_hold_count() as h`);
        assertEquals(h[0].h, 2, "only its own two tickets are its holds");
      });
      assertEquals(
        await ledger(sql, v1),
        ["allocated"],
        "deleted owner's ticket survives, untouched",
      );
      assertEquals(await ledger(sql, v2), ["allocated"]);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATK-07 — free-rating conservation across online + offline paths
// ---------------------------------------------------------------------------
Deno.test({
  name: "W04-01 ATK-07: conservation — scored + live reservations + offline holds ≤ 2 in every ordering (issue after 2 scored, issue beside a permit, permit beside tickets, sync beside a ticket), released tickets keep counting, a stale permit cannot settle a third rating beside two held tickets",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      // (a) two scored ratings already spent → no tickets.
      await createUser(sql, 11, [{ provider: "google", sub: SUB("u11") }]);
      await inTx(sql, 11, async (tx) => {
        assertEquals((await register(tx, KEY("a"))).result, "accepted");
        for (let i = 0; i < 2; i += 1) {
          const p = await reserve(tx, `k${i}`);
          assertEquals(p.result, "accepted");
          assertEquals(
            await applySynced(tx, { ...shotPayload(shotId()), analysisPermitId: p.permit_id }),
            "accepted",
          );
        }
        const g = await issue(tx, KEY("a"), 2);
        assertEquals(g.result, "access.paywall_required", "(a) no ticket beyond 2 scored");
        assertEquals(g.ticket_ids ?? [], []);
        assertEquals((await issue(tx, KEY("a"), 1)).result, "access.paywall_required");
      });

      // (b) one live permit → one ticket; then nothing more either way.
      await createUser(sql, 12, [{ provider: "google", sub: SUB("u12") }]);
      await inTx(sql, 12, async (tx) => {
        assertEquals((await register(tx, KEY("b"))).result, "accepted");
        const p = await reserve(tx, "live");
        assertEquals(p.result, "accepted");
        const g = await issue(tx, KEY("b"), 2);
        assertEquals(g.result, "accepted");
        assertEquals(g.ticket_ids?.length, 1, "(b) one ticket beside one live permit");
        assertEquals((await reserve(tx, "third")).result, "access.paywall_required");
        assertEquals((await issue(tx, KEY("b"), 2)).result, "accepted", "reissue is idempotent");
        assertEquals((await issue(tx, KEY("b"), 2)).ticket_ids?.length, 1, "no extra ticket");
        // settle both
        assertEquals(
          await applySynced(tx, { ...shotPayload(shotId()), analysisPermitId: p.permit_id }),
          "accepted",
        );
        assertEquals(await consume(tx, g.ticket_ids![0], shotPayload(shotId())), "accepted");
        assertEquals((await reserve(tx, "fourth")).result, "access.paywall_required");
        assertEquals((await issue(tx, KEY("b"), 2)).result, "access.paywall_required");
        const st = await tx.unsafe<{ scored_count: number; reserved_count: number }[]>(
          `select scored_count, reserved_count from public.access_state()`,
        );
        assertEquals(st[0].scored_count, 2);
        assertEquals(st[0].reserved_count, 0);
      });

      // (c) two tickets → no permit; sync without permit refused.
      const [c1] = await setupUser(sql, 13, KEY("c"));
      await inTx(sql, 13, async (tx) => {
        assertEquals((await reserve(tx, "p")).result, "access.paywall_required", "(c)");
        const st = await tx.unsafe<{ reserved_count: number }[]>(
          `select reserved_count from public.access_state()`,
        );
        assertEquals(st[0].reserved_count, 2, "holds are visible as reserved");
        assertEquals(await release(tx, c1), "accepted");
        assertEquals(
          (await reserve(tx, "p2")).result,
          "access.paywall_required",
          "(c) a released ticket still counts — never re-credited",
        );
        assertEquals((await issue(tx, KEY("c"), 2)).ticket_ids?.length, 1, "only the live one");
        assertEquals(await consume(tx, c1, shotPayload(shotId())), "offline.ticket_released");
      });

      // (d) permit reserved, then tickets issued (1), then a late sync on the
      // permit, then consume: exactly 2 scored, nothing more.
      await createUser(sql, 14, [{ provider: "google", sub: SUB("u14") }]);
      await inTx(sql, 14, async (tx) => {
        assertEquals((await register(tx, KEY("d"))).result, "accepted");
        const p = await reserve(tx, "d1");
        assertEquals(p.result, "accepted");
        const g = await issue(tx, KEY("d"), 2);
        assertEquals(g.ticket_ids?.length, 1);
        assertEquals(await consume(tx, g.ticket_ids![0], shotPayload(shotId())), "accepted");
        assertEquals(
          await applySynced(tx, { ...shotPayload(shotId()), analysisPermitId: p.permit_id }),
          "accepted",
          "(d) the reserved permit still settles beside the consumed ticket",
        );
        assertEquals((await reserve(tx, "d2")).result, "access.paywall_required");
      });
      assertEquals(
        await count(
          sql,
          `select 1 from public.shots where user_id = '${U(14)}' and result_kind = 'scored'`,
        ),
        2,
      );

      // (e) stale (>24h) permit is not a live reservation → 2 tickets issue;
      // the stale permit must then NOT settle a third rating.
      await createUser(sql, 15, [{ provider: "google", sub: SUB("u15") }]);
      // owner stands in for a reservation made 25 hours ago (the permit state
      // machine forbids rewriting created_at, so the aged row is inserted).
      const stale = crypto.randomUUID();
      await sql.unsafe(
        `insert into public.analysis_permits (id, user_id, idempotency_key, status, created_at)
         values ('${stale}', '${U(15)}', 'stale-${RUN}', 'reserved', now() - interval '25 hours')`,
      );
      await inTx(sql, 15, async (tx) => {
        assertEquals((await register(tx, KEY("e"))).result, "accepted");
        const g = await issue(tx, KEY("e"), 2);
        assertEquals(g.ticket_ids?.length, 2, "(e) stale permit does not block issuance");
        const r = await applySynced(tx, { ...shotPayload(shotId()), analysisPermitId: stale });
        assertEquals(r, "access.paywall_required", "(e) stale permit cannot be a third rating");
        // and the direct-insert gate agrees
        await expectSqlState(
          "(e) direct scored insert with stale permit beside 2 holds",
          () =>
            tx.savepoint((sp) =>
              sp.unsafe(
                `select set_config('pickle.sync_permit_id', '${stale}', true);
                 insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind)
                 values ('${shotId()}', '${U(15)}', 'dink', 'side', '2026-09-01T10:00:00Z', 0, 100, 200, 7, 0.9, 'scored')`,
              ),
            ),
          "42501",
          "23514",
          "PKP01",
          "PKP02",
        );
      });
      assertEquals(
        await count(sql, `select 1 from public.shots where user_id = '${U(15)}'`),
        0,
        "(e) nothing written",
      );
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATK-08 — concurrency on issuance and reservation
// ---------------------------------------------------------------------------
Deno.test({
  name: "W04-01 ATK-08: overlapping issue/issue on one device returns identical tickets and 2 allocated rows; overlapping issue on two devices of one account allocates 2 in total; issue overlapping reserve_analysis_permit keeps scored+reserved+held ≤ 2; an 8-lane issue burst over two devices allocates exactly 2",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 24 });
    try {
      // same device
      await createUser(sql, 16, [{ provider: "google", sub: SUB("u16") }]);
      await inTx(sql, 16, async (tx) => {
        assertEquals((await register(tx, KEY("s1"))).result, "accepted");
      });
      const same = await overlap(
        sql,
        { n: 16, fn: (tx) => issue(tx, KEY("s1"), 2) },
        { n: 16, fn: (tx) => issue(tx, KEY("s1"), 2) },
      );
      assert(!("error" in same.b), `second issue must not raise: ${JSON.stringify(same.b)}`);
      const sb = same.b as Grant;
      assertEquals(same.a.result, "accepted");
      assertEquals(sb.result, "accepted");
      assertEquals(
        sb.ticket_ids?.slice().sort(),
        same.a.ticket_ids?.slice().sort(),
        "same tickets",
      );
      assertEquals(
        await count(
          sql,
          `select 1 from public.offline_allocation_ledger where user_id = '${U(16)}'`,
        ),
        2,
      );

      // two devices, one account
      await createUser(sql, 17, [{ provider: "google", sub: SUB("u17") }]);
      await inTx(sql, 17, async (tx) => {
        assertEquals((await register(tx, KEY("d1"))).result, "accepted");
        assertEquals((await register(tx, KEY("d2"))).result, "accepted");
      });
      const two = await overlap(
        sql,
        { n: 17, fn: (tx) => issue(tx, KEY("d1"), 2) },
        { n: 17, fn: (tx) => issue(tx, KEY("d2"), 2) },
      );
      assert(!("error" in two.b), `second device must not raise: ${JSON.stringify(two.b)}`);
      const tb = two.b as Grant;
      assertEquals(two.a.ticket_ids?.length, 2);
      assertEquals(tb.ticket_ids?.length ?? 0, 0, "second device gets nothing");
      assertEquals(tb.result, "access.paywall_required");
      assertEquals(
        await count(
          sql,
          `select 1 from public.offline_allocation_ledger where user_id = '${U(17)}'`,
        ),
        2,
      );

      // issue vs reserve
      await createUser(sql, 18, [{ provider: "google", sub: SUB("u18") }]);
      await inTx(sql, 18, async (tx) => {
        assertEquals((await register(tx, KEY("r1"))).result, "accepted");
      });
      const mixed = await overlap(
        sql,
        { n: 18, fn: (tx) => issue(tx, KEY("r1"), 2) },
        { n: 18, fn: (tx) => reserve(tx, "race") },
      );
      assert(!("error" in mixed.b), `reserve must not raise: ${JSON.stringify(mixed.b)}`);
      const mb = mixed.b as { result: string };
      assertEquals(mixed.a.ticket_ids?.length, 2);
      assertEquals(mb.result, "access.paywall_required", "no permit beside two holds");
      const st = await accessState(sql, 18);
      assertEquals(st.scored_count + st.reserved_count, 2);

      // burst over two devices
      await createUser(sql, 19, [{ provider: "google", sub: SUB("u19") }]);
      await inTx(sql, 19, async (tx) => {
        assertEquals((await register(tx, KEY("b1"))).result, "accepted");
        assertEquals((await register(tx, KEY("b2"))).result, "accepted");
      });
      const lanes = await burst(
        sql,
        () => 19,
        8,
        (tx, lane) => issue(tx, lane % 2 === 0 ? KEY("b1") : KEY("b2"), 2),
      );
      assertEquals(
        lanes.filter((l) => !l.ok),
        [],
        "no lane raises",
      );
      const tickets = new Set<string>();
      for (const l of lanes) {
        if (l.ok) for (const t of l.value.ticket_ids ?? []) tickets.add(t);
      }
      assertEquals(tickets.size, 2, `exactly two distinct tickets (${JSON.stringify(lanes)})`);
      assertEquals(
        await count(
          sql,
          `select 1 from public.offline_allocation_ledger where user_id = '${U(19)}'`,
        ),
        2,
      );
      await inTx(sql, 19, async (tx) => {
        assertEquals((await reserve(tx, "after-burst")).result, "access.paywall_required");
      });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATK-09 — Pro lease boundaries
// ---------------------------------------------------------------------------
Deno.test({
  name: "W04-01 ATK-09: Pro leases carry no tickets and are ≤ 7 days and ≤ verified entitlement expiry for lifetime (null), far, near, 'infinity' and just-expiring entitlements; a lapsed or non-premium entitlement falls back to the free path; generations increase and grant rows are immutable",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const key = KEY("pro");
      const SEVEN_DAYS = 7 * 24 * 3600;
      await createUser(sql, 20, [{ provider: "google", sub: SUB("u20") }]);
      await inTx(sql, 20, async (tx) => {
        assertEquals((await register(tx, key)).result, "accepted");
      });

      const cases: Array<[string, string | null, (g: Grant) => void]> = [
        [
          "lifetime (null expiry)",
          null,
          (g) => {
            assertEquals(g.entitlement_source, "verified_store");
            assertEquals(Math.round(g.lease_seconds!), SEVEN_DAYS, "exactly 7 days");
            assertEquals(g.entitlement_expires_at, null);
          },
        ],
        [
          "far entitlement (30 days)",
          new Date(Date.now() + 30 * 86400_000).toISOString(),
          (g) => {
            assertEquals(g.entitlement_source, "verified_store");
            assertEquals(Math.round(g.lease_seconds!), SEVEN_DAYS, "capped at 7 days");
          },
        ],
        [
          "near entitlement (2 days)",
          new Date(Date.now() + 2 * 86400_000).toISOString(),
          (g) => {
            assertEquals(g.entitlement_source, "verified_store");
            assert(
              g.lease_seconds! <= 2 * 86400 && g.lease_seconds! > 2 * 86400 - 120,
              `lease ends at the entitlement (${g.lease_seconds})`,
            );
            assertEquals(
              new Date(g.expires_at!).getTime(),
              new Date(g.entitlement_expires_at!).getTime(),
              "lease expiry == entitlement expiry",
            );
          },
        ],
        [
          "entitlement 'infinity'",
          "infinity",
          (g) => {
            assertEquals(g.entitlement_source, "verified_store");
            assertEquals(Math.round(g.lease_seconds!), SEVEN_DAYS);
          },
        ],
        [
          "entitlement expiring in 5 seconds",
          new Date(Date.now() + 5_000).toISOString(),
          (g) => {
            assertEquals(g.entitlement_source, "verified_store");
            assert(
              g.lease_seconds! <= 5 && g.lease_seconds! > 0,
              `tiny lease (${g.lease_seconds})`,
            );
          },
        ],
      ];
      let lastGeneration = 0;
      for (const [label, exp, check] of cases) {
        await setEntitlement(sql, 20, true, exp);
        const g = await inTx(sql, 20, (tx) => issue(tx, key, 2));
        assertEquals(g.result, "accepted", label);
        assertEquals(g.ticket_ids ?? [], [], `${label}: Pro lease carries no tickets`);
        assert(g.lease_seconds! > 0 && g.lease_seconds! <= SEVEN_DAYS, `${label}: ≤ 7 days`);
        check(g);
        assert(g.generation! > lastGeneration, `${label}: generation increases`);
        lastGeneration = g.generation!;
      }
      assertEquals(
        await count(
          sql,
          `select 1 from public.offline_allocation_ledger where user_id = '${U(20)}'`,
        ),
        0,
        "no allocation rows from Pro leases",
      );
      const state = await accessState(sql, 20);
      assertEquals(state.premium, true);

      // lapsed entitlement (premium=true but expired): free path.
      await setEntitlement(sql, 20, true, new Date(Date.now() - 1_000).toISOString());
      const lapsed = await inTx(sql, 20, (tx) => issue(tx, key, 2));
      assertEquals(lapsed.result, "accepted");
      assertEquals(lapsed.entitlement_source, "identity_lifetime_free", "lapsed → free");
      assertEquals(lapsed.ticket_ids?.length, 2);
      assertEquals(lapsed.entitlement_expires_at, null);
      assert(lapsed.lease_seconds! <= SEVEN_DAYS);
      // non-premium row
      await setEntitlement(sql, 20, false, null);
      const free = await inTx(sql, 20, (tx) => issue(tx, key, 2));
      assertEquals(free.entitlement_source, "identity_lifetime_free");
      assertEquals(free.ticket_ids?.slice().sort(), lapsed.ticket_ids?.slice().sort(), "reissued");

      // A grant row can never be stretched (owner attempt) and a verified
      // grant can never be forged past the entitlement (owner attempt).
      await setEntitlement(sql, 20, true, new Date(Date.now() + 86400_000).toISOString());
      const device = await sql.unsafe<{ id: string }[]>(
        `select id::text as id from public.offline_devices where user_id = '${U(20)}'`,
      );
      await expectSqlState(
        "owner forges a 30-day Pro lease",
        () =>
          sql.unsafe(
            `insert into public.offline_grants (user_id, device_id, generation, entitlement_source, issued_at, expires_at, entitlement_expires_at)
             values ('${U(20)}', '${device[0].id}', 999, 'verified_store', now(), now() + interval '30 days',
                     (select expires_at from public.billing_entitlements where user_id = '${U(20)}'))`,
          ),
        "23514",
      );
      await expectSqlState(
        "owner forges a 8-day lease",
        () =>
          sql.unsafe(
            `insert into public.offline_grants (user_id, device_id, generation, entitlement_source, issued_at, expires_at)
             values ('${U(20)}', '${device[0].id}', 998, 'identity_lifetime_free', now(), now() + interval '8 days')`,
          ),
        "23514",
      );
      // Pro again → tickets held on this device remain (never reclaimed).
      const pro = await inTx(sql, 20, (tx) => issue(tx, key, 2));
      assertEquals(pro.entitlement_source, "verified_store");
      assertEquals(pro.ticket_ids ?? [], []);
      assertEquals(
        await count(
          sql,
          `select 1 from public.offline_allocation_ledger where user_id = '${U(20)}' and event = 'allocated'`,
        ),
        2,
        "the free tickets are still held",
      );
      const t = lapsed.ticket_ids![0];
      await inTx(sql, 20, async (tx) => {
        assertEquals(await consume(tx, t, shotPayload(shotId())), "accepted", "still consumable");
      });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATK-10 — registration state machine
// ---------------------------------------------------------------------------
Deno.test({
  name: "W04-01 ATK-10: an attested device never downgrades on an unattested re-registration; an environment change for a known key is refused; an unattested device gets no grant until attested; re-registration is idempotent on device id",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const key = KEY("atk10");
      await createUser(sql, 21, [{ provider: "google", sub: SUB("u21") }]);
      await inTx(sql, 21, async (tx) => {
        const first = await register(tx, key, "production", false);
        assertEquals(first.result, "accepted");
        assertEquals(first.attestation_state, "unattested");
        assertEquals((await issue(tx, key, 2)).result, "offline.device_not_attested");
        assertEquals(
          (await register(tx, key, "development", true)).result,
          "offline.device_environment_mismatch",
        );
        const up = await register(tx, key, "production", true);
        assertEquals(up.result, "accepted");
        assertEquals(up.attestation_state, "attested");
        assertEquals(up.device_id, first.device_id, "same device");
        const down = await register(tx, key, "production", false);
        assertEquals(down.result, "accepted");
        assertEquals(down.attestation_state, "attested", "never downgrades");
        assertEquals(down.device_id, first.device_id);
        assertEquals(
          (await register(tx, key, "development", false)).result,
          "offline.device_environment_mismatch",
        );
        const g = await issue(tx, key, 2);
        assertEquals(g.result, "accepted");
        assertEquals(g.ticket_ids?.length, 2);
      });
      assertEquals(
        await count(sql, `select 1 from public.offline_devices where user_id = '${U(21)}'`),
        1,
      );
      const dev = await sql.unsafe<{ attestation_state: string; attested_at: string | null }[]>(
        `select attestation_state, attested_at::text as attested_at from public.offline_devices where user_id = '${U(21)}'`,
      );
      assertEquals(dev[0].attestation_state, "attested");
      assert(dev[0].attested_at !== null);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATK-11 — process death / account deletion / restart on the same install
// ---------------------------------------------------------------------------
Deno.test({
  name: "W04-01 ATK-11: after consuming one ticket the account is deleted and re-created through the SAME identity on the SAME installation — the outstanding ticket is recovered (not re-allocated), the consumed one is not re-credited, no online permit fits, and the lifetime total stays exactly 2",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const key = KEY("atk11");
      const identity: Identity = { provider: "apple", sub: SUB("u22") };
      const [t1, t2] = await setupUser(sql, 22, key, [identity]);
      await inTx(sql, 22, async (tx) => {
        assertEquals(await consume(tx, t1, shotPayload(shotId())), "accepted");
      });
      await deleteUser(sql, 22);
      assertEquals(await ledger(sql, t1), ["allocated", "consumed"], "ledger survives deletion");
      assertEquals(await ledger(sql, t2), ["allocated"]);

      await createUser(sql, 23, [identity]);
      await inTx(sql, 23, async (tx) => {
        const st = await tx.unsafe<{ scored_count: number; reserved_count: number }[]>(
          `select scored_count, reserved_count from public.access_state()`,
        );
        assertEquals(st[0].scored_count, 1, "consumed ticket follows the identity");
        assertEquals(st[0].reserved_count, 1, "outstanding ticket is still a hold");
        assertEquals((await reserve(tx, "p")).result, "access.paywall_required");
        assertEquals((await register(tx, key)).result, "accepted");
        const g = await issue(tx, key, 2);
        assertEquals(g.result, "accepted");
        assertEquals(g.ticket_ids, [t2], "recovers exactly the outstanding ticket, allocates none");
        assertEquals(await consume(tx, t1, shotPayload(shotId())), "offline.ticket_consumed");
        assertEquals(await consume(tx, t2, shotPayload(shotId())), "accepted");
        assertEquals((await issue(tx, key, 2)).result, "access.paywall_required");
        assertEquals((await reserve(tx, "p2")).result, "access.paywall_required");
        const after = await tx.unsafe<{ scored_count: number; reserved_count: number }[]>(
          `select scored_count, reserved_count from public.access_state()`,
        );
        assertEquals(after[0].scored_count, 2);
        assertEquals(after[0].reserved_count, 0);
      });
      assertEquals(
        await count(
          sql,
          `select 1 from public.offline_allocation_ledger where ticket_id in ('${t1}','${t2}')`,
        ),
        4,
        "allocated+consumed ×2, nothing else",
      );
      // A NEW installation for the same identity gets nothing extra.
      await inTx(sql, 23, async (tx) => {
        assertEquals((await register(tx, KEY("atk11-newphone"))).result, "accepted");
        assertEquals((await issue(tx, KEY("atk11-newphone"), 2)).result, "access.paywall_required");
      });
    } finally {
      await sql.end();
    }
  },
});
