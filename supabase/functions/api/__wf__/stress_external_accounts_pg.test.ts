/**
 * Boundary/malformed-input stress campaign — POSTGRES plane.
 *
 * Runs against a real Postgres 16 with `supabase/tests/shim_auth.sql` and
 * EVERY migration applied (exactly what supabase/tests/run_rls_tests.sh
 * builds), e.g.
 *
 *   docker run -d --name stress-ext-pg -p 55432:5432 -e POSTGRES_PASSWORD=pg postgres:16
 *   docker cp supabase/tests stress-ext-pg:/tests && docker cp supabase/migrations stress-ext-pg:/migrations
 *   docker exec stress-ext-pg bash -c 'psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql;
 *     for f in /migrations/*.sql; do psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f"; done'
 *   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:55432/postgres deno test -A --no-check --config deno.json stress_external_accounts_pg.test.ts
 *
 * Skipped (ignore) when STRESS_PG_URL is unset. Exercises the real
 * `account_external_credentials` table with REAL ciphertext produced by
 * externalAccounts.ts: size caps vs token length, the token/capture pair
 * constraint, upsert idempotency, client-role denial (RLS + revoked grants),
 * hostile ids and profile cascade — every SQL rejection must be a typed
 * SQLSTATE with no row written.
 */
import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import {
  decryptAppleRefreshToken,
  encryptAppleRefreshToken,
} from "../externalAccounts.ts";
import {
  b64std,
  boundaryString,
  Campaign,
  describeInput,
  errorSummary,
  familySelected,
  GRAPHEME_CLUSTERS,
  NORMALIZATION_PAIRS,
  Prng,
  randomAscii,
  randomUnicode,
  seedsFor,
  STRESS_ITER,
  TRAVERSAL_SLUGS,
} from "./stress_external_accounts_gen.ts";
import { decryptScenario, wtf8 } from "./stress_external_accounts_fixtures.ts";

const PG_URL = Deno.env.get("STRESS_PG_URL") ?? "";
const ignore = PG_URL === "";
const FILE = "stress_external_accounts_pg.test.ts";
const KEY = b64std(crypto.getRandomValues(new Uint8Array(32)));
const OTHER_KEY = b64std(crypto.getRandomValues(new Uint8Array(32)));
const TABLE = "public.account_external_credentials";
const CIPHERTEXT_CAP = 8192;
const CIPHERTEXT_MIN = 20;
const KNOWN_BOM_NOTE =
  "leading U+FEFF is stripped by TextDecoder on decrypt (lossy round trip)";

type Sql = ReturnType<typeof postgres>;

function sqlState(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return `no-sqlstate(${errorSummary(error)})`;
}

async function attempt(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (error) {
    return sqlState(error);
  }
}

async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql`insert into auth.users (id, email) values (${userId}::uuid, ${`${userId}@example.com`}) on conflict (id) do nothing`;
  // The auth.users trigger from the migrations may already have created the profile.
  await sql`insert into public.profiles (id, email, provider) values (${userId}::uuid, ${`${userId}@example.com`}, 'apple') on conflict (id) do update set provider = 'apple'`;
}

async function dropUser(sql: Sql, userId: string): Promise<void> {
  await sql`delete from auth.users where id = ${userId}::uuid`;
}

async function countRows(sql: Sql, userId: string): Promise<number> {
  const rows =
    await sql`select count(*)::int as n from public.account_external_credentials where user_id = ${userId}::uuid`;
  return Number(rows[0].n);
}

async function storedFor(
  sql: Sql,
  userId: string,
): Promise<{ token: string | null; captured: Date | null } | null> {
  const rows =
    await sql`select apple_refresh_token_encrypted as token, apple_token_captured_at as captured from public.account_external_credentials where user_id = ${userId}::uuid`;
  if (rows.length === 0) return null;
  return {
    token: rows[0].token as string | null,
    captured: rows[0].captured as Date | null,
  };
}

/** Insert or upsert exactly the way the edge function does through PostgREST
 * (`upsert(..., { onConflict: "user_id" })` → INSERT ... ON CONFLICT (user_id) DO UPDATE). */
async function upsertCredential(
  sql: Sql,
  userId: string,
  token: string | null,
  captured: Date | null,
): Promise<void> {
  await sql`
    insert into public.account_external_credentials
      (user_id, apple_refresh_token_encrypted, apple_token_captured_at, apple_revoked_at, updated_at)
    values (${userId}::uuid, ${token}, ${captured}, null, now())
    on conflict (user_id) do update set
      apple_refresh_token_encrypted = excluded.apple_refresh_token_encrypted,
      apple_token_captured_at = excluded.apple_token_captured_at,
      apple_revoked_at = excluded.apple_revoked_at,
      updated_at = excluded.updated_at`;
}

/** Run `probe` as a client role with a JWT sub, inside a rolled-back
 * transaction, returning the SQLSTATE or "ok". */
async function asRole(
  sql: Sql,
  role: "anon" | "authenticated",
  sub: string | null,
  probe: (tx: Sql) => Promise<unknown>,
): Promise<string> {
  let outcome = "ok";
  try {
    await sql.begin(async (tx) => {
      if (sub) {
        await tx`select set_config('request.jwt.claim.sub', ${sub}, true)`;
      }
      await tx.unsafe(`set local role ${role}`);
      try {
        await probe(tx as unknown as Sql);
      } catch (error) {
        outcome = sqlState(error);
      }
      throw new Error("rollback");
    });
  } catch (error) {
    if (!(error instanceof Error && error.message === "rollback")) throw error;
  }
  return outcome;
}

function refreshTokenVariant(rng: Prng): { token: string; kind: string } {
  const kind = rng.pick([
    "apple-like",
    "apple-like",
    "apple-like",
    "one-char",
    "near-cap",
    "boundary",
    "unicode",
    "grapheme",
    "normalization",
    "nul",
    "lone-surrogate",
    "traversal",
    "64k",
  ]);
  switch (kind) {
    case "apple-like":
      return {
        token: `r${randomAscii(rng, rng.int(60, 220)).replace(/\s/g, "_")}`,
        kind,
      };
    case "one-char":
      return { token: rng.pick(["a", "0", " ", "\u00e9", "\u{1F600}"]), kind };
    case "near-cap": {
      // v1.<16 chars iv>.<base64url(N+16 bytes)> — cap 8192 chars ⇒ ~6108 plaintext bytes.
      const bytes = 6_100 + rng.int(0, 20);
      return { token: "t".repeat(bytes), kind: `near-cap:${bytes}` };
    }
    case "boundary": {
      const b = boundaryString(rng, 4096);
      return { token: b.value, kind: `boundary:${b.kind}` };
    }
    case "unicode":
      return { token: randomUnicode(rng, rng.int(1, 120)), kind };
    case "grapheme":
      return {
        token: rng.pick(GRAPHEME_CLUSTERS).repeat(rng.int(1, 40)),
        kind,
      };
    case "normalization":
      return { token: rng.pick(NORMALIZATION_PAIRS)[rng.int(0, 1)], kind };
    case "nul":
      return {
        token: `${randomAscii(rng, 10)}\u0000${randomAscii(rng, 10)}`,
        kind,
      };
    case "lone-surrogate":
      return { token: `\ud800${randomAscii(rng, 12)}`, kind };
    case "traversal":
      return { token: rng.pick(TRAVERSAL_SLUGS), kind };
    default:
      return { token: randomAscii(rng, 65_536), kind };
  }
}

Deno.test({
  name:
    `stress pg-credential-storage ×${STRESS_ITER}: real ciphertext vs account_external_credentials caps, pair check, upsert, client denial, cascade`,
  ignore: ignore || !familySelected("pg-credential-storage"),
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    const campaign = new Campaign("pg-credential-storage", FILE);
    try {
      for (const { index, seed } of seedsFor(campaign.family)) {
        const rng = new Prng(seed);
        const userId = rng.uuid();
        const variant = refreshTokenVariant(rng);
        const problems: string[] = [];
        let note: string | undefined;
        let encrypted = "";
        let encryptError: string | null = null;
        try {
          encrypted = await encryptAppleRefreshToken(
            variant.token,
            userId,
            KEY,
          );
        } catch (error) {
          encryptError = errorSummary(error);
        }
        const fits = encryptError === null &&
          encrypted.length >= CIPHERTEXT_MIN &&
          encrypted.length <= CIPHERTEXT_CAP;
        const expected = encryptError
          ? "encrypt rejects (typed) → nothing to store"
          : fits
          ? "insert ok; read-back byte-exact; decrypts; upsert idempotent; clients denied; cascade"
          : `insert rejected 23514 (${encrypted.length} chars > cap), no row`;

        await createUser(sql, userId);
        try {
          if (encryptError) {
            if (!encryptError.startsWith("ExternalAccountError")) {
              problems.push(`encrypt threw untyped ${encryptError}`);
            }
          } else {
            const captured = new Date();
            const first = await attempt(() =>
              upsertCredential(sql, userId, encrypted, captured)
            );
            const rows = await countRows(sql, userId);
            if (fits) {
              if (first !== "ok") {
                problems.push(
                  `insert of ${encrypted.length}-char ciphertext → ${first}`,
                );
              }
              if (rows !== 1) problems.push(`rows=${rows} after insert`);
              const stored = await storedFor(sql, userId);
              if (stored?.token !== encrypted) {
                problems.push("ciphertext not byte-exact after round trip");
              } else {
                try {
                  const plain = await decryptAppleRefreshToken(
                    stored.token,
                    userId,
                    KEY,
                  );
                  const want = wtf8(variant.token);
                  if (plain !== want) {
                    if (want.startsWith("\ufeff")) {
                      note = KNOWN_BOM_NOTE;
                    } else {
                      problems.push("decrypt(read-back) ≠ token");
                    }
                  }
                } catch (error) {
                  const summary = errorSummary(error);
                  const typed = summary.startsWith("ExternalAccountError");
                  if (typed && variant.token === "") {
                    // Empty plaintext is refused on decrypt by design (empty-token guard).
                  } else if (typed && wtf8(variant.token) === "\ufeff") {
                    note = KNOWN_BOM_NOTE;
                  } else {
                    problems.push(`decrypt(read-back) threw ${summary}`);
                  }
                }
              }
              // Idempotent re-capture (second bootstrap) — one row, latest wins.
              const second = await encryptAppleRefreshToken(
                variant.token,
                userId,
                KEY,
              );
              const again = await attempt(() =>
                upsertCredential(sql, userId, second, new Date())
              );
              if (again !== "ok") problems.push(`re-upsert → ${again}`);
              if ((await countRows(sql, userId)) !== 1) {
                problems.push("upsert produced a second row");
              }
              if ((await storedFor(sql, userId))?.token !== second) {
                problems.push("upsert did not replace the ciphertext");
              }
              // Pair constraint: token without capture / capture without token.
              const halfA = await attempt(() =>
                sql`update public.account_external_credentials set apple_token_captured_at = null where user_id = ${userId}::uuid`
              );
              if (halfA !== "23514") {
                problems.push(`token-without-capture → ${halfA}`);
              }
              const halfB = await attempt(() =>
                sql`update public.account_external_credentials set apple_refresh_token_encrypted = null where user_id = ${userId}::uuid`
              );
              if (halfB !== "23514") {
                problems.push(`capture-without-token → ${halfB}`);
              }
              // Revocation / permanent-failure clear (the route's PATCH).
              const cleared = await attempt(() =>
                sql`update public.account_external_credentials set apple_refresh_token_encrypted = null, apple_token_captured_at = null, updated_at = now() where user_id = ${userId}::uuid`
              );
              if (cleared !== "ok") problems.push(`clear → ${cleared}`);
              // Client roles: RLS on, no policies, grants revoked → 42501.
              const authedRead = await asRole(
                sql,
                "authenticated",
                userId,
                (tx) => tx`select * from public.account_external_credentials`,
              );
              const authedWrite = await asRole(
                sql,
                "authenticated",
                userId,
                (tx) =>
                  tx`update public.account_external_credentials set apple_revoked_at = now() where user_id = ${userId}::uuid`,
              );
              const anonRead = await asRole(
                sql,
                "anon",
                null,
                (tx) => tx`select * from public.account_external_credentials`,
              );
              for (
                const [label, outcome] of [
                  ["authenticated select", authedRead],
                  ["authenticated update", authedWrite],
                  ["anon select", anonRead],
                ] as const
              ) {
                if (outcome !== "42501") problems.push(`${label} → ${outcome}`);
              }
            } else {
              if (first !== "23514") {
                problems.push(
                  `oversized ciphertext (${encrypted.length}) → ${first}, expected 23514`,
                );
              }
              if (rows !== 0) {
                problems.push(`rows=${rows} after rejected insert`);
              }
            }
          }
          // Profile deletion cascades the credential row (auth.users → profiles → credentials).
          await dropUser(sql, userId);
          const left = await countRows(sql, userId);
          if (left !== 0) {
            problems.push(`${left} credential row(s) survived user deletion`);
          }
        } finally {
          await dropUser(sql, userId).catch(() => undefined);
        }
        campaign.record({
          index,
          seed,
          input: `token=${variant.kind} len=${variant.token.length} bytes=${
            new TextEncoder().encode(variant.token).byteLength
          } ciphertext=${encryptError ? "n/a" : encrypted.length}`,
          outcome: `${
            encryptError ?? (fits ? "stored+verified" : "rejected-23514")
          }${problems.length ? ` | ${problems.join("; ")}` : ""}`,
          expected,
          verdict: problems.length || note ? "BROKEN" : "HELD",
          note,
        });
      }
    } finally {
      await sql.end();
    }
    const { path, report } = campaign.write();
    console.log(
      `[stress] ${campaign.family}: ${report.iterations} ran, ${report.broken} BROKEN → ${path}`,
    );
    // Known defect (finding F3): a leading U+FEFF does not round-trip. Nothing else may break.
    const unexpected = report.rows.filter((r) =>
      r.verdict === "BROKEN" && r.note !== KNOWN_BOM_NOTE
    );
    assertEquals(unexpected, []);
  },
});

Deno.test({
  name:
    `stress pg-credential-hostile-rows ×${STRESS_ITER}: hostile user ids and corrupt ciphertext text → typed SQLSTATE or opaque storage, never a stray row`,
  ignore: ignore || !familySelected("pg-credential-hostile-rows"),
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    const campaign = new Campaign("pg-credential-hostile-rows", FILE);
    try {
      for (const { index, seed } of seedsFor(campaign.family)) {
        const rng = new Prng(seed);
        const userId = rng.uuid();
        const problems: string[] = [];
        const mode = rng.pick([
          "hostile-id",
          "hostile-id",
          "corrupt-text",
          "corrupt-text",
          "corrupt-text",
        ]);
        let input: string;
        let outcome: string;
        let expected: string;
        await createUser(sql, userId);
        try {
          if (mode === "hostile-id") {
            const idKind = rng.pick([
              "unknown-uuid",
              "nil-uuid",
              "traversal",
              "not-uuid",
              "uppercase-uuid",
              "braced-uuid",
              "injection",
              "empty",
              "unicode",
            ]);
            let id: string;
            switch (idKind) {
              case "unknown-uuid":
                id = rng.uuid();
                break;
              case "nil-uuid":
                id = "00000000-0000-0000-0000-000000000000";
                break;
              case "traversal":
                id = rng.pick(TRAVERSAL_SLUGS);
                break;
              case "not-uuid":
                id = randomAscii(rng, 36);
                break;
              case "uppercase-uuid":
                id = userId.toUpperCase();
                break;
              case "braced-uuid":
                id = `{${userId}}`;
                break;
              case "injection":
                id =
                  `${userId}'; drop table public.account_external_credentials; --`;
                break;
              case "empty":
                id = "";
                break;
              default:
                id = randomUnicode(rng, 36);
            }
            const encrypted = await encryptAppleRefreshToken(
              "token",
              userId,
              KEY,
            );
            // Postgres accepts upper-case and braced UUID spellings as the same value.
            const sameUser = idKind === "uppercase-uuid" ||
              idKind === "braced-uuid";
            expected = sameUser
              ? "ok (canonicalised to the profile id)"
              : idKind === "unknown-uuid" || idKind === "nil-uuid"
              ? "23503 (no such profile), no row"
              : "22P02 (invalid uuid text), no row";
            const result = await attempt(() =>
              upsertCredential(sql, id, encrypted, new Date())
            );
            const rows = await countRows(sql, userId);
            const total = Number(
              (await sql`select count(*)::int as n from public.account_external_credentials`)[
                0
              ].n,
            );
            if (sameUser) {
              if (result !== "ok" || rows !== 1) {
                problems.push(`canonical id variant → ${result}, rows=${rows}`);
              }
            } else {
              const wantState =
                idKind === "unknown-uuid" || idKind === "nil-uuid"
                  ? "23503"
                  : id.includes("\u0000")
                  ? "22021"
                  : "22P02";
              if (result !== wantState) {
                problems.push(`→ ${result}, expected ${wantState}`);
              }
              if (total !== 0) {
                problems.push(`${total} stray row(s) after rejected insert`);
              }
            }
            const tableStillThere = Number(
              (await sql`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'account_external_credentials'`)[
                0
              ].n,
            );
            if (tableStillThere !== 1) problems.push("TABLE GONE");
            input = `id=${idKind} ${describeInput(id, 60)}`;
            outcome = `${result} rows=${rows}`;
          } else {
            const scenario = await decryptScenario(rng, userId, KEY, OTHER_KEY);
            const text = scenario.encrypted;
            const hasNul = text.includes("\u0000");
            const inCap = text.length >= CIPHERTEXT_MIN &&
              text.length <= CIPHERTEXT_CAP;
            expected = hasNul
              ? "22021 (NUL in text), no row"
              : inCap
              ? "stored opaquely (DB cannot validate ciphertext); read-back byte-exact"
              : "23514 (size cap), no row";
            const result = await attempt(() =>
              upsertCredential(sql, userId, text, new Date())
            );
            const stored = await storedFor(sql, userId);
            if (hasNul) {
              if (result !== "22021") problems.push(`NUL text → ${result}`);
              if (stored) problems.push("row written despite NUL rejection");
            } else if (!inCap) {
              if (result !== "23514") {
                problems.push(`len ${text.length} → ${result}`);
              }
              if (stored) problems.push("row written despite cap rejection");
            } else {
              if (result !== "ok") problems.push(`in-cap text → ${result}`);
              // Lone surrogates cannot exist in UTF-8; the wire encoder maps them to U+FFFD.
              if (stored?.token !== wtf8(text)) {
                problems.push("stored text not byte-exact");
              }
            }
            input = `corrupt=${scenario.kind} len=${text.length} ${
              describeInput(text, 50)
            }`;
            outcome = `${result} stored=${stored ? "yes" : "no"}`;
          }
        } finally {
          await dropUser(sql, userId).catch(() => undefined);
        }
        campaign.record({
          index,
          seed,
          input,
          outcome: `${outcome}${
            problems.length ? ` | ${problems.join("; ")}` : ""
          }`,
          expected,
          verdict: problems.length ? "BROKEN" : "HELD",
        });
      }
    } finally {
      await sql.end();
    }
    const { path, report } = campaign.write();
    console.log(
      `[stress] ${campaign.family}: ${report.iterations} ran, ${report.broken} BROKEN → ${path}`,
    );
    assertEquals(report.brokenSeeds, []);
  },
});

Deno.test({
  name:
    "stress pg fixture: every migration applied and the credential table is RLS-enabled with no client grants",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      const rls =
        await sql`select relrowsecurity as on from pg_class where oid = ${TABLE}::regclass`;
      assertEquals(rls[0].on, true);
      const grants =
        await sql`select grantee from information_schema.role_table_grants where table_schema = 'public' and table_name = 'account_external_credentials' and grantee in ('anon', 'authenticated', 'PUBLIC')`;
      assertEquals(
        grants.length,
        0,
        `client grants present: ${grants.map((g) => g.grantee).join(",")}`,
      );
      const policies =
        await sql`select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = 'account_external_credentials'`;
      assertEquals(Number(policies[0].n), 0);
      const version = await sql`show server_version`;
      assert(
        String(version[0].server_version).startsWith("16."),
        String(version[0].server_version),
      );
    } finally {
      await sql.end();
    }
  },
});
