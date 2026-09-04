// ADVERSARIAL PASS 3 — mobile-settings-account, scenario S6 (edge half).
//
// The app's exit-survey comment is capped at ACCOUNT_DELETION_DETAILS_MAX =
// 500 on the client and DELETION_SURVEY_DETAILS_MAX = 500 on the server
// (`parseDeletionSurvey` → `sanitizeUserText(details, 500)`), with the DB
// CHECK `length(details) <= 1000`. Here the REAL handler receives survey
// details of 500 multibyte emoji and 600 ASCII characters (and a few uglier
// shapes) and we inspect exactly what `recordDeletionSurvey` hands PostgREST
// for `account_deletion_feedback`.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json \
//     attack/settingsAccount.s6.surveyDetailsUnicode.attack.test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { sanitizeUserText } from "../../http.ts";
import {
  fakeGoogleIdToken,
  loadHarness,
  TEST_USER_ID,
  userRequest,
} from "../routesHarness.ts";

const h = await loadHarness();

const codePoints = (s: string): number => Array.from(s).length;

/** Deterministic emoji sequence (LCG; seed recorded in the test name). */
function seededEmoji(count: number, seed: number): string {
  const palette = ["😀", "🎾", "🏓", "🥒", "🔥", "💯", "🙌", "🤝"];
  let x = seed >>> 0;
  let out = "";
  for (let i = 0; i < count; i += 1) {
    x = (x * 1_664_525 + 1_013_904_223) >>> 0;
    out += palette[x % palette.length];
  }
  return out;
}
const SEED = 20260904;

let ipCounter = 0;

/** Each request is a fresh user on a fresh IP: delete-request has a tight
 * per-user budget (429 after a few in one window) and the harness keeps
 * rate-limit state in isolate memory across tests. The fake PostgREST
 * ignores filters, so the seeded profile row is served to every user. */
function surveyRequest(details: unknown): Request {
  ipCounter += 1;
  return userRequest("POST", "/v1/me/delete-request", {
    token: fakeGoogleIdToken(crypto.randomUUID()),
    ip: `198.51.100.${ipCounter}`,
    body: {
      survey: {
        reason: "too_expensive",
        wanted: "price",
        details,
        platform: "ios",
        appVersion: "1.0",
      },
    },
  });
}

function seedContext(): void {
  h.tables.profiles = [
    {
      id: TEST_USER_ID,
      email: "u@example.com",
      provider: "google",
      created_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
    },
  ];
  h.rpcs.access_state = [{
    premium: false,
    scored_count: 2,
    reserved_count: 0,
  }];
}

function storedDetails(): string | null | undefined {
  const inserts = h
    .callsTo("/rest/v1/account_deletion_feedback")
    .filter((c) => c.method === "POST");
  assertEquals(inserts.length, 1, "exactly one survey insert");
  const body = inserts[0].body as { details?: string | null };
  return body.details;
}

Deno.test(`S6 edge: 500 emoji (seed ${SEED}) → stored intact at 500 code points / 1000 UTF-16`, async () => {
  h.reset();
  seedContext();
  const details = seededEmoji(500, SEED);
  assertEquals(details.length, 1000);
  const res = await h.handler(surveyRequest(details));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const stored = storedDetails();
  assert(typeof stored === "string");
  console.info(
    `[attack s6 edge] emoji500 stored: codePoints=${
      codePoints(stored)
    } utf16=${stored.length}`,
  );
  assertEquals(codePoints(stored), 500);
  assertEquals(stored, details);
  // DB CHECK is length(details) <= 1000 (pg length = characters) — 500 ≤ 1000.
  assert(codePoints(stored) <= 1000);
});

Deno.test("S6 edge: 600 ASCII chars → stored truncated to exactly 500 (server cap holds)", async () => {
  h.reset();
  seedContext();
  const details = Array.from(
    { length: 600 },
    (_, i) => String.fromCharCode(97 + (i % 26)),
  ).join(
    "",
  );
  const res = await h.handler(surveyRequest(details));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const stored = storedDetails();
  assert(typeof stored === "string");
  console.info(`[attack s6 edge] ascii600 stored length=${stored.length}`);
  assertEquals(stored.length, 500);
  assertEquals(stored, details.slice(0, 500));
});

Deno.test("S6 edge: 600 emoji (1200 UTF-16) → truncated to 500 code points, never splitting a surrogate pair", async () => {
  h.reset();
  seedContext();
  const details = seededEmoji(600, SEED + 1);
  const res = await h.handler(surveyRequest(details));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const stored = storedDetails();
  assert(typeof stored === "string");
  assertEquals(codePoints(stored), 500);
  assertEquals(stored.length, 1000);
  assertEquals(stored, Array.from(details).slice(0, 500).join(""));
  // No lone surrogate survived the cut.
  assertEquals(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
      .test(stored),
    false,
  );
});

Deno.test("S6 edge: 499 ASCII + a 2-unit emoji at the boundary → kept whole (cap counts code points)", async () => {
  h.reset();
  seedContext();
  const details = "a".repeat(499) + "🥒" + "b".repeat(50);
  const res = await h.handler(surveyRequest(details));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const stored = storedDetails();
  assert(typeof stored === "string");
  assertEquals(codePoints(stored), 500);
  assert(stored.endsWith("🥒"));
});

Deno.test("S6 edge: 20 000-code-point payload (attacker ignores the app) → still capped at 500, request 200", async () => {
  h.reset();
  seedContext();
  const details = seededEmoji(20_000, SEED + 2);
  const res = await h.handler(surveyRequest(details));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const stored = storedDetails();
  assert(typeof stored === "string");
  assertEquals(codePoints(stored), 500);
});

Deno.test("S6 edge: control chars, bidi overrides, NUL and lone surrogates are stripped before storage", async () => {
  h.reset();
  seedContext();
  const details = "ok\u0000\u202e evil\u200b\u200b text\ud83d tail\u0007";
  const res = await h.handler(surveyRequest(details));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const stored = storedDetails();
  assertEquals(stored, "ok evil text tail");
});

Deno.test("S6 edge: whitespace-only details → stored as null (not empty string)", async () => {
  h.reset();
  seedContext();
  const res = await h.handler(surveyRequest(" \n\t \u200b "));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(storedDetails(), null);
});

Deno.test("S6 edge: non-string details (array / object / number) → survey still recorded with null details", async () => {
  for (const bad of [["x"], { a: 1 }, 42]) {
    h.reset();
    seedContext();
    const res = await h.handler(surveyRequest(bad));
    assertEquals(res.status, 200);
    await res.body?.cancel();
    assertEquals(storedDetails(), null);
  }
});

// ─── sanitizeUserText unit-level probes (documenting the ZWJ decision) ────────

Deno.test("S6 unit: ZWJ emoji sequences lose their U+200D joiner (sequence decomposes into parts)", () => {
  // 👨‍👩‍👧 = 1F468 200D 1F469 200D 1F467 — a single grapheme to the user.
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  const out = sanitizeUserText(family, 500);
  console.info(
    `[attack s6 unit] family ZWJ: in codePoints=${
      codePoints(family)
    } out codePoints=${codePoints(out)} out=${JSON.stringify(out)}`,
  );
  // Documented behaviour: U+200D is in the zero-width strip set, so the joined
  // family renders as three separate people after sanitization. Not a
  // data-integrity or security failure; recorded as a fidelity note.
  assertEquals(out, "\u{1F468}\u{1F469}\u{1F467}");
});

Deno.test("S6 unit: variation selector (U+FE0F) and skin-tone modifiers survive", () => {
  const thumbs = "\u{1F44D}\u{1F3FD}"; // 👍🏽
  const heart = "\u2764\uFE0F"; // ❤️
  assertEquals(
    sanitizeUserText(thumbs + " " + heart, 500),
    thumbs + " " + heart,
  );
});

Deno.test("S6 unit: cap never yields trailing whitespace and is idempotent", () => {
  const input = "word ".repeat(200); // 1000 chars, cut lands after 'word' + space
  const once = sanitizeUserText(input, 500);
  assert(!/\s$/.test(once));
  assertEquals(sanitizeUserText(once, 500), once);
});
