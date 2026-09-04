// Cross-cutting i18n: Unicode names / free text through the REAL edge
// handler (routesHarness.ts — Supabase + RevenueCat stubbed at fetch, no
// hosted project touched). Drives PUT /v1/me/onboarding, POST
// /v1/me/delete-request, POST /v1/me/consent/grant, POST /v1/shots:sync and
// the JSON body cap, and records what each layer RECEIVED vs STORED in
// u16 / code points / graphemes / bytes.
//
// Replayable: XC_I18N_SEED, XC_I18N_ITERS (route matrix uses ITERS/10, min
// 200). XC_I18N_OUT=<dir> writes routes_*.json artifacts.
//
//   XC_I18N_OUT=/tmp/xc deno test -A --no-check --config deno.json xc_i18n_routes_test.ts
//
// Convention (as in account_routes.test.ts): `REPRO:` tests pin CURRENT
// behaviour identified as a defect; the assertion is what the route does
// today.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";
import {
  CLUSTERS,
  codePointsOf,
  count,
  FREE_TEXT,
  itersFromEnv,
  KB64,
  makeRng,
  measureHeap,
  NAMES,
  randomGraphemeName,
  randomMixedString,
  SAFE_CLUSTERS,
  seedFromEnv,
  stringOfBytes,
  WIDE_SAFE_CLUSTERS,
  writeArtifact,
} from "./xc_i18n_unicode_corpus.ts";

const SEED = seedFromEnv(20260904);
const ROUTE_ITERS = Math.max(200, Math.floor(itersFromEnv(20_000) / 10));

/** Client-side contract for the onboarding first-name field
 * (apps/mobile/src/screens/OnboardingScreen.tsx: `maxLength={40}` on the
 * TextInput and `firstName.length >= 1`) — UTF-16 code units. */
const CLIENT_FIRST_NAME_MAX_U16 = 40;
/** Server-side check (index.ts PUT /v1/me/onboarding): `cleaned.length > 40`. */
const SERVER_FIRST_NAME_MAX_U16 = 40;
/** DB check (20260831000000_scale_and_security.sql profiles_first_name_length):
 * `char_length(first_name) <= 80` — code points. */
const DB_FIRST_NAME_MAX_CP = 80;

let requestCounter = 0;
/** Every request gets its own user and IP so per-user / per-IP rate budgets
 * (240/min, 1200/min) never shape the matrix. */
function fresh(): { token: string; ip: string; sub: string } {
  requestCounter += 1;
  const n = requestCounter;
  const sub = `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  const ip = `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
  return { token: fakeGoogleIdToken(sub), ip, sub };
}

const onboardingBody = (firstName: unknown) => ({
  skillLevel: "beginner",
  handedness: "right",
  goal: "dinks",
  biggestProblem: "consistency",
  firstName,
});

interface OnboardingOutcome {
  status: number;
  errorMessage: string | null;
  storedFirstName: string | null;
}

async function putOnboarding(firstName: unknown): Promise<OnboardingOutcome> {
  const h = await loadHarness();
  const { token, ip } = fresh();
  const before = h.calls.length;
  const res = await h.handler(
    userRequest("PUT", "/v1/me/onboarding", {
      token,
      ip,
      body: onboardingBody(firstName),
    }),
  );
  const text = await res.text();
  let errorMessage: string | null = null;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    errorMessage = parsed.error?.message ?? null;
  } catch {
    errorMessage = null;
  }
  const patch = h.calls
    .slice(before)
    .find((c) => c.method === "PATCH" && c.url.includes("/rest/v1/profiles"));
  const body = patch?.body as Record<string, unknown> | undefined;
  return {
    status: res.status,
    errorMessage,
    storedFirstName: body && typeof body.first_name === "string" ? body.first_name : null,
  };
}

const measure = (s: string) => ({
  u16: count.u16(s),
  cp: count.cp(s),
  graphemes: count.graphemes(s),
  bytes: count.bytes(s),
});

// ─── Onboarding first name: corpus + property matrix ─────────────────────────

interface NameRow {
  name: string;
  inputJson: string;
  inputCodePoints: string[];
  in: ReturnType<typeof measure>;
  status: number;
  errorMessage: string | null;
  passedValidation: boolean;
  storedJson: string | null;
  stored: ReturnType<typeof measure> | null;
  storedEqualsTrimmedInput: boolean | null;
  storedEqualsRawInput: boolean | null;
  graphemesChanged: boolean | null;
}

async function nameRow(name: string, input: string): Promise<NameRow> {
  const out = await putOnboarding(input);
  const stored = out.storedFirstName;
  return {
    name,
    inputJson: JSON.stringify(input),
    inputCodePoints: codePointsOf(input),
    in: measure(input),
    status: out.status,
    errorMessage: out.errorMessage,
    passedValidation: out.status !== 400 && stored !== null,
    storedJson: stored === null ? null : JSON.stringify(stored),
    stored: stored === null ? null : measure(stored),
    storedEqualsTrimmedInput: stored === null ? null : stored === input.trim(),
    storedEqualsRawInput: stored === null ? null : stored === input,
    graphemesChanged:
      stored === null ? null : count.graphemes(stored) !== count.graphemes(input.trim()),
  };
}

Deno.test(
  "onboarding firstName: named Unicode corpus through the real route (matrix recorded)",
  async () => {
    const rows: NameRow[] = [];
    for (const c of NAMES) rows.push(await nameRow(c.name, c.text));
    writeArtifact("routes_onboarding_name_corpus.json", rows);

    // Plain names in every script must be accepted and stored byte-for-byte.
    const mustPass = [
      "ascii",
      "latin_diacritics_nfc",
      "latin_diacritics_nfd",
      "vietnamese",
      "polish",
      "greek",
      "cyrillic",
      "hebrew_rtl",
      "hebrew_with_points",
      "arabic_rtl",
      "arabic_with_harakat",
      "urdu",
      "mixed_rtl_ltr_name",
      "devanagari",
      "bengali",
      "tamil",
      "thai",
      "korean_nfc",
      "korean_nfd_jamo",
      "japanese_kanji_kana",
      "chinese",
      "cjk_ext_b",
      "emoji_only_3",
      "apostrophe_hyphen",
      "typographic_apostrophe",
    ];
    for (const n of mustPass) {
      const r = rows.find((row) => row.name === n)!;
      assert(r.passedValidation, `${n} rejected: ${r.status} ${r.errorMessage}`);
      assertEquals(r.storedEqualsTrimmedInput, true, `${n} stored altered: ${r.storedJson}`);
    }
    // Spoofing / control input must be cleaned, never stored raw.
    const expectedCleaned: Record<string, string> = {
      bidi_override_attack: "ecilA",
      zero_width_space_inside: "Alice",
      bom_prefix: "Alice",
      nul_inside: "Alice",
      c1_controls: "Alice",
      lone_high_surrogate: "Alice",
      lone_low_surrogate: "Alice",
      crlf_tabs: "Al ice",
    };
    for (const [n, expected] of Object.entries(expectedCleaned)) {
      const r = rows.find((row) => row.name === n)!;
      assert(r.passedValidation, `${n} unexpectedly rejected: ${r.status}`);
      assertEquals(r.storedEqualsRawInput, false, `${n} stored raw: ${r.storedJson}`);
      assertEquals(r.storedJson, JSON.stringify(expected), n);
    }
    // Whitespace-only must be rejected.
    assertEquals(rows.find((r) => r.name === "nbsp_only")!.status, 400);
  },
);

Deno.test(
  "property: a 3-grapheme name from ZWJ-free clusters is never rejected as too long by PUT /v1/me/onboarding (counterexamples recorded)",
  async () => {
    const rng = makeRng(SEED ^ 0x2001);
    const counterexamples: Array<Record<string, unknown>> = [];
    const perPool: Record<string, { iterations: number; accepted: number; rejected: number }> = {};
    const started = performance.now();
    // Pool A: uniform over every ZWJ-free cluster. Pool B: only clusters that are
    // one grapheme but ≥ 12 UTF-16 units (tag-sequence flags, stacked marks).
    const pools = [
      {
        pool: "all_safe_clusters",
        clusters: SAFE_CLUSTERS,
        iterations: ROUTE_ITERS,
      },
      {
        pool: "wide_safe_clusters",
        clusters: WIDE_SAFE_CLUSTERS,
        iterations: Math.max(50, Math.floor(ROUTE_ITERS / 4)),
      },
    ];
    for (const { pool, clusters: poolClusters, iterations } of pools) {
      const stats = { iterations, accepted: 0, rejected: 0 };
      perPool[pool] = stats;
      for (let i = 0; i < iterations; i += 1) {
        const { text, clusters } = randomGraphemeName(rng, 3, poolClusters);
        assertEquals(count.graphemes(text), 3);
        const out = await putOnboarding(text);
        if (out.status === 400) {
          stats.rejected += 1;
          if (counterexamples.length < 200) {
            counterexamples.push({
              seed: SEED,
              pool,
              iteration: i,
              clusters,
              inputJson: JSON.stringify(text),
              inputCodePoints: codePointsOf(text),
              in: measure(text),
              errorMessage: out.errorMessage,
            });
          }
        } else {
          stats.accepted += 1;
        }
      }
    }
    const path = writeArtifact("routes_onboarding_three_grapheme_property.json", {
      seed: SEED,
      perPool,
      rejectedTotal: Object.values(perPool).reduce((n, s) => n + s.rejected, 0),
      ms: Math.round(performance.now() - started),
      heap: measureHeap(),
      counterexamples,
    });
    // The property the role states MUST hold. It does not: every counterexample
    // is a 3-grapheme name whose UTF-16 length exceeds 40 (tag-sequence flags,
    // long skin-tone sequences). Pinned as REPRO below with a deterministic input.
    if (counterexamples.length > 0) {
      console.warn(
        `[xc-i18n] 3-grapheme property violated: ${JSON.stringify(
          perPool,
        )}; see ${path ?? "(set XC_I18N_OUT)"}`,
      );
    }
    for (const ce of counterexamples) {
      assertStringIncludes(String(ce.errorMessage), "1-40 characters");
      assert(
        (ce.in as { u16: number }).u16 > SERVER_FIRST_NAME_MAX_U16,
        "rejection must be the length check",
      );
    }
  },
);

Deno.test(
  "REPRO: a 3-grapheme name (three tag-sequence flags, 21 code points) is rejected by PUT /v1/me/onboarding as 'firstName must be 1-40 characters'",
  async () => {
    const flag = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}";
    const name = flag.repeat(3);
    assertEquals(count.graphemes(name), 3);
    assertEquals(count.cp(name), 21);
    assertEquals(count.u16(name), 42); // > 40 UTF-16 units
    assert(count.cp(name) <= DB_FIRST_NAME_MAX_CP);
    const out = await putOnboarding(name);
    assertEquals(out.status, 400);
    assertStringIncludes(out.errorMessage ?? "", "firstName must be 1-40 characters");
    assertEquals(out.storedFirstName, null);
  },
);

Deno.test(
  "REPRO: a 40-grapheme NFD name that the client input accepts is rejected server-side (UTF-16 units vs graphemes)",
  async () => {
    // 39 × "a" + "e" + U+0301: 40 graphemes, 41 UTF-16 units, 41 code points.
    const name = "a".repeat(39) + "e\u0301";
    assertEquals(count.graphemes(name), 40);
    assertEquals(count.u16(name), 41);
    const out = await putOnboarding(name);
    assertEquals(out.status, 400);
    assertStringIncludes(out.errorMessage ?? "", "1-40 characters");
  },
);

Deno.test(
  "REPRO: ZWJ/ZWNJ names are accepted but stored altered (family emoji -> 4 people, علی‌رضا -> علیرضا, ශ්‍රී -> ශ්රී)",
  async () => {
    const cases: Array<[string, string]> = [
      [
        "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}",
        "\u{1f468}\u{1f469}\u{1f467}\u{1f466}",
      ],
      ["علی\u200cرضا", "علیرضا"],
      ["ශ්\u200dරී", "ශ්රී"],
      ["क्\u200dष", "क्ष"],
    ];
    for (const [input, expectedStoredToday] of cases) {
      const out = await putOnboarding(input);
      assert(out.status !== 400, `unexpectedly rejected: ${out.errorMessage}`);
      assertEquals(out.storedFirstName, expectedStoredToday, codePointsOf(input).join(" "));
    }
  },
);

Deno.test(
  "REPRO: an invisible-only first name (U+2060 word joiner / U+3164 Hangul filler / U+00AD) passes the 'must not be empty' check and is stored",
  async () => {
    for (const invisible of ["\u2060", "\u3164", "\u00ad", "\u034f", "\u{e0041}\u{e0042}"]) {
      const out = await putOnboarding(invisible);
      assert(
        out.status !== 400,
        `rejected ${codePointsOf(invisible).join(" ")}: ${out.errorMessage}`,
      );
      assertEquals(out.storedFirstName, invisible);
    }
  },
);

Deno.test(
  "property: random mixed-script strings never store a forbidden char, never exceed the DB cap, and never 5xx on validation",
  async () => {
    const rng = makeRng(SEED ^ 0x2002);
    const FORBIDDEN =
      // deno-lint-ignore no-control-regex
      /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/; // eslint-disable-line no-control-regex
    const failures: Array<Record<string, unknown>> = [];
    const statusHistogram: Record<string, number> = {};
    for (let i = 0; i < ROUTE_ITERS; i += 1) {
      const { text, alphabets } = randomMixedString(rng, 1 + rng.int(80));
      const out = await putOnboarding(text);
      statusHistogram[String(out.status)] = (statusHistogram[String(out.status)] ?? 0) + 1;
      const stored = out.storedFirstName;
      const problems: string[] = [];
      if (stored !== null) {
        if (FORBIDDEN.test(stored)) problems.push("forbidden char stored");
        if (!stored.isWellFormed()) problems.push("lone surrogate stored");
        if (count.cp(stored) > DB_FIRST_NAME_MAX_CP) {
          problems.push("exceeds DB char_length cap");
        }
        if (stored.length > SERVER_FIRST_NAME_MAX_U16) {
          problems.push("exceeds server u16 cap");
        }
        if (stored !== stored.trim()) problems.push("untrimmed");
      }
      if (
        out.status >= 500 &&
        out.errorMessage !== null &&
        !/coaching profile/i.test(out.errorMessage)
      ) {
        problems.push(`unexpected 5xx: ${out.errorMessage}`);
      }
      if (problems.length) {
        failures.push({
          seed: SEED,
          iteration: i,
          alphabets,
          inputJson: JSON.stringify(text),
          inputCodePoints: codePointsOf(text),
          storedJson: JSON.stringify(stored),
          status: out.status,
          problems,
        });
      }
    }
    writeArtifact("routes_onboarding_random_property.json", {
      seed: SEED,
      iterations: ROUTE_ITERS,
      statusHistogram,
      failures,
      heap: measureHeap(),
    });
    assertEquals(failures.length, 0, JSON.stringify(failures.slice(0, 3)));
  },
);

// ─── Free text: exit-survey details, consent device ──────────────────────────

Deno.test(
  "free text: 64 KiB survey.details never reaches the feedback insert uncapped (<= 500 code points); Unicode corpus preserved",
  async () => {
    const h = await loadHarness();
    const rows: Array<Record<string, unknown>> = [];
    const units = ["a", "\u{1f600}", "\u0627", "e\u0301", "\u6f22", "\u200b", " "];
    for (const unit of units) {
      const details = stringOfBytes(unit, KB64);
      const { token, ip } = fresh();
      const before = h.calls.length;
      const res = await h.handler(
        userRequest("POST", "/v1/me/delete-request", {
          token,
          ip,
          body: {
            survey: {
              reason: "not_using",
              details,
              platform: "ios",
              appVersion: "1.0.0",
            },
          },
        }),
      );
      const insert = h.calls
        .slice(before)
        .find((c) => c.method === "POST" && c.url.includes("/rest/v1/account_deletion_feedback"));
      const stored = (insert?.body as { details?: unknown } | undefined)?.details;
      rows.push({
        unit: JSON.stringify(unit),
        inBytes: count.bytes(details),
        status: res.status,
        stored: typeof stored === "string" ? measure(stored) : (stored ?? null),
      });
      assertEquals(res.status, 200);
      assert(insert, "survey insert must happen");
      if (unit.trim() === "" || unit === "\u200b") {
        assertEquals(stored, null, "whitespace/zero-width-only details must be stored as null");
      } else {
        assert(typeof stored === "string");
        assert(count.cp(stored) <= 500, `details cp ${count.cp(stored)} > 500`);
        assert(count.bytes(stored) <= 2000);
      }
    }
    for (const c of FREE_TEXT) {
      const { token, ip } = fresh();
      const before = h.calls.length;
      const res = await h.handler(
        userRequest("POST", "/v1/me/delete-request", {
          token,
          ip,
          body: { survey: { reason: "other", details: c.text } },
        }),
      );
      const insert = h.calls
        .slice(before)
        .find(
          (c2) => c2.method === "POST" && c2.url.includes("/rest/v1/account_deletion_feedback"),
        );
      const stored = (insert?.body as { details?: unknown } | undefined)?.details;
      rows.push({
        name: c.name,
        inputJson: JSON.stringify(c.text),
        storedJson: JSON.stringify(stored),
        status: res.status,
        in: measure(c.text),
        stored: typeof stored === "string" ? measure(stored) : null,
      });
      assertEquals(res.status, 200);
      if (c.expectUnchanged) assertEquals(stored, c.text, c.name);
    }
    writeArtifact("routes_delete_request_details.json", rows);
  },
);

Deno.test(
  "free text: consent device string is capped at 512 code points (<= 2048 bytes, within the DB's pg_column_size 4096 check)",
  async () => {
    const h = await loadHarness();
    const rows: Array<Record<string, unknown>> = [];
    for (const unit of [
      "a",
      "\u{1f600}",
      "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}",
      "\u0627",
    ]) {
      const device = stringOfBytes(unit, KB64);
      const { token, ip } = fresh();
      const before = h.calls.length;
      const res = await h.handler(
        userRequest("POST", "/v1/me/consent/grant", {
          token,
          ip,
          body: {
            scope: "video_analysis",
            consentVersion: "2026-09-01",
            source: "settings",
            device,
            captureMode: "camera",
          },
        }),
      );
      const insert = h.calls
        .slice(before)
        .find((c) => c.method === "POST" && c.url.includes("/rest/v1/consent_records"));
      const stored = (insert?.body as { device?: unknown } | undefined)?.device;
      assert(typeof stored === "string");
      rows.push({
        unit: JSON.stringify(unit),
        inBytes: count.bytes(device),
        status: res.status,
        stored: measure(stored),
      });
      assert(count.cp(stored) <= 512);
      assert(count.bytes(stored) <= 2048);
    }
    writeArtifact("routes_consent_device_cap.json", rows);
  },
);

Deno.test(
  "REPRO: consent consentVersion / captureMode are sanitized to 64 code points but the DB check allows 50 — a 51..64 char value passes the edge and can only fail at insert",
  async () => {
    const h = await loadHarness();
    const consentVersion = "v".repeat(60);
    const { token, ip } = fresh();
    const before = h.calls.length;
    const res = await h.handler(
      userRequest("POST", "/v1/me/consent/grant", {
        token,
        ip,
        body: {
          scope: "video_analysis",
          consentVersion,
          captureMode: "c".repeat(60),
        },
      }),
    );
    const insert = h.calls
      .slice(before)
      .find((c) => c.method === "POST" && c.url.includes("/rest/v1/consent_records"));
    assert(insert, "edge forwards the insert (no 400)");
    const body = insert.body as { consent_version: string; capture_mode: string };
    assertEquals(body.consent_version.length, 60); // > 50 = consent_records_bounds
    assertEquals(body.capture_mode.length, 60); // > 50 = consent_records_bounds
    assert(res.status !== 400);
  },
);

// ─── shots:sync: unsanitized text fields ─────────────────────────────────────

function syncShot(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    source: "real",
    analysisPermitId: crypto.randomUUID(),
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: new Date().toISOString(),
    timestamps: { startMs: 0, contactMs: 500, endMs: 1000 },
    resultKind: "scored",
    overallScore: 7.5,
    confidence: 0.9,
    phases: [
      {
        key: "prep",
        startMs: 0,
        representativeMs: 100,
        endMs: 400,
        confidence: 0.9,
      },
    ],
    checkpoints: [
      {
        key: "contact_position",
        score: 80,
        confidence: 0.9,
        band: "green",
        direction: "ok",
        severity: 0.1,
        applicable: true,
      },
    ],
    versionVector: {
      appVersion: "1.0.0",
      modelBundleVersion: "b1",
      poseModelVersion: "p1",
      paddleModelVersion: "pd1",
      strokeDetectorVersion: "s1",
      phaseModelVersion: "ph1",
      scoringModelVersion: "sc1",
      shotConfigVersion: "cfg1",
    },
    ...overrides,
  };
}

Deno.test(
  "shots:sync text fields: length is checked in UTF-16 units and nothing is sanitized (matrix recorded)",
  async () => {
    const h = await loadHarness();
    h.rpcs["apply_synced_shot"] = "accepted";
    h.tables["shots"] = [];
    const cases: Array<{ name: string; field: string; value: string }> = [
      { name: "shotType_64_ascii", field: "shotType", value: "d".repeat(64) },
      { name: "shotType_65_ascii", field: "shotType", value: "d".repeat(65) },
      {
        name: "shotType_33_emoji_u16_66_cp_33",
        field: "shotType",
        value: "\u{1f3d3}".repeat(33),
      },
      { name: "shotType_64_cjk", field: "shotType", value: "\u6f22".repeat(64) },
      { name: "shotType_with_nul", field: "shotType", value: "dink\u0000" },
      { name: "shotType_with_rlo", field: "shotType", value: "\u202edink" },
      { name: "shotType_lone_surrogate", field: "shotType", value: "dink\ud800" },
      {
        name: "shotType_zwsp_only_plus_letter",
        field: "shotType",
        value: "\u200bd",
      },
      {
        name: "shotType_64KiB",
        field: "shotType",
        value: stringOfBytes("d", KB64),
      },
      {
        name: "appVersion_with_nul",
        field: "versionVector.appVersion",
        value: "1.0\u0000",
      },
      {
        name: "appVersion_64KiB",
        field: "versionVector.appVersion",
        value: stringOfBytes("v", KB64),
      },
      {
        name: "phaseKey_rtl",
        field: "phases[0].key",
        value: "\u0645\u0631\u062d\u0644\u0629",
      },
      {
        name: "phaseKey_65_ascii",
        field: "phases[0].key",
        value: "k".repeat(65),
      },
      {
        name: "direction_64KiB",
        field: "checkpoints[0].direction",
        value: stringOfBytes("x", KB64),
      },
      {
        name: "direction_bidi",
        field: "checkpoints[0].direction",
        value: "\u202eup",
      },
    ];
    const rows: Array<Record<string, unknown>> = [];
    for (const c of cases) {
      const shot = syncShot({});
      if (c.field === "shotType") shot.shotType = c.value;
      if (c.field === "versionVector.appVersion") {
        (shot.versionVector as Record<string, unknown>).appVersion = c.value;
      }
      if (c.field === "phases[0].key") {
        (shot.phases as Array<Record<string, unknown>>)[0].key = c.value;
      }
      if (c.field === "checkpoints[0].direction") {
        (shot.checkpoints as Array<Record<string, unknown>>)[0].direction = c.value;
      }
      const { token, ip } = fresh();
      const before = h.calls.length;
      const res = await h.handler(
        userRequest("POST", "/v1/shots:sync", {
          token,
          ip,
          body: { shots: [shot] },
        }),
      );
      const json = (await res.json()) as {
        acceptedIds?: string[];
        rejected?: Array<{ code: string; message: string }>;
      };
      const rpc = h.calls
        .slice(before)
        .find((k) => k.url.includes("/rest/v1/rpc/apply_synced_shot"));
      const rpcShot = (rpc?.body as { shot?: Record<string, unknown> } | undefined)?.shot;
      let forwarded: unknown = null;
      if (rpcShot) {
        if (c.field === "shotType") forwarded = rpcShot.shotType;
        if (c.field === "versionVector.appVersion") {
          forwarded = (rpcShot.versionVector as Record<string, unknown>).appVersion;
        }
        if (c.field === "phases[0].key") {
          forwarded = (rpcShot.phases as Array<Record<string, unknown>>)[0].key;
        }
        if (c.field === "checkpoints[0].direction") {
          forwarded = (rpcShot.checkpoints as Array<Record<string, unknown>>)[0].direction;
        }
      }
      rows.push({
        name: c.name,
        field: c.field,
        in: measure(c.value),
        status: res.status,
        accepted: (json.acceptedIds ?? []).length,
        rejected: json.rejected ?? [],
        forwardedToRpcUnchanged: forwarded === c.value,
        forwardedJson:
          typeof forwarded === "string" ? JSON.stringify(forwarded.slice(0, 80)) : null,
      });
    }
    writeArtifact("routes_shots_sync_text_fields.json", rows);
    const byName = (n: string) => rows.find((r) => r.name === n)!;
    // Byte / code point / UTF-16 mismatch: 33 emoji = 33 code points (DB length() ok) but 66 UTF-16 units → rejected.
    assertEquals(byName("shotType_64_ascii").accepted, 1);
    assertEquals(byName("shotType_65_ascii").accepted, 0);
    assertEquals(byName("shotType_33_emoji_u16_66_cp_33").accepted, 0);
    assertEquals(byName("shotType_64KiB").accepted, 0);
    assertEquals(byName("direction_64KiB").accepted, 0);
    assertEquals(byName("appVersion_64KiB").accepted, 0);
    // REPRO: unsanitized — NUL / RLO / lone surrogate / ZWSP pass validation and are forwarded verbatim to apply_synced_shot.
    for (const n of [
      "shotType_with_nul",
      "shotType_with_rlo",
      "shotType_lone_surrogate",
      "shotType_zwsp_only_plus_letter",
      "appVersion_with_nul",
      "direction_bidi",
    ]) {
      assertEquals(byName(n).forwardedToRpcUnchanged, true, n);
    }
  },
);

// ─── JSON body cap (bytes) ───────────────────────────────────────────────────

Deno.test(
  "body cap: a 64 KiB firstName inside the JSON body is bounded (400, never stored); 5 MB + 1 byte body → 413 regardless of script",
  async () => {
    const h = await loadHarness();
    const rows: Array<Record<string, unknown>> = [];
    for (const unit of ["a", "\u{1f600}", "\u0627", "\u6f22"]) {
      const out = await putOnboarding(stringOfBytes(unit, KB64));
      rows.push({
        kind: "firstName_64KiB",
        unit: JSON.stringify(unit),
        status: out.status,
        stored: out.storedFirstName,
      });
      assertEquals(out.status, 400);
      assertEquals(out.storedFirstName, null);
    }
    const MAX = 5_000_000;
    for (const unit of ["a", "\u{1f600}", "\u0627"]) {
      // Body = {"firstName":"<filler>"} sized to exactly MAX+1 bytes.
      const wrapper = '{"firstName":""}';
      const filler = stringOfBytes(unit, MAX + 1 - count.bytes(wrapper));
      let body = `{"firstName":"${filler}"}`;
      while (count.bytes(body) <= MAX) {
        body = body.slice(0, -2) + "aa" + body.slice(-2);
      }
      const { token, ip } = fresh();
      const res = await h.handler(
        new Request("http://edge.test/functions/v1/api/v1/me/onboarding", {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "x-forwarded-for": ip,
            "Content-Type": "application/json",
          },
          body,
        }),
      );
      rows.push({
        kind: "body_over_5MB",
        unit: JSON.stringify(unit),
        bytes: count.bytes(body),
        status: res.status,
      });
      assertEquals(res.status, 413, `${count.bytes(body)} bytes of ${JSON.stringify(unit)}`);
      await res.body?.cancel();
    }
    // Exactly at the cap with a multi-byte script: passes the byte cap, then the field cap rejects it (400), never 413/5xx.
    {
      const wrapper = '{"firstName":""}';
      const filler = stringOfBytes("\u{1f600}", MAX - count.bytes(wrapper));
      const body = `{"firstName":"${filler}"}`;
      assert(count.bytes(body) <= MAX);
      const { token, ip } = fresh();
      const res = await h.handler(
        new Request("http://edge.test/functions/v1/api/v1/me/onboarding", {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "x-forwarded-for": ip,
            "Content-Type": "application/json",
          },
          body,
        }),
      );
      rows.push({
        kind: "body_at_cap_emoji",
        bytes: count.bytes(body),
        status: res.status,
        heap: measureHeap(),
      });
      assertEquals(res.status, 400);
      await res.body?.cancel();
    }
    // Spoofed content-length smaller than the real body: the streamed count still trips the cap.
    {
      const filler = "a".repeat(MAX + 100);
      const body = `{"firstName":"${filler}"}`;
      const { token, ip } = fresh();
      const res = await h.handler(
        new Request("http://edge.test/functions/v1/api/v1/me/onboarding", {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "x-forwarded-for": ip,
            "Content-Type": "application/json",
            "content-length": "10",
          },
          body,
        }),
      );
      rows.push({
        kind: "body_spoofed_content_length",
        bytes: count.bytes(body),
        status: res.status,
      });
      assertEquals(res.status, 413);
      await res.body?.cancel();
    }
    writeArtifact("routes_body_cap.json", rows);
  },
);

// ─── Cap parity table: client ↔ edge ↔ DB, in their own units ────────────────

Deno.test(
  "cap parity: the same field is bounded in three different units across client, edge and DB (table recorded; mismatches pinned)",
  () => {
    const table = [
      {
        field: "profiles.first_name",
        client: "OnboardingScreen maxLength=40 (UTF-16 units)",
        edge: "sanitizeUserText(·,200) then .length<=40 (UTF-16 units)",
        db: "char_length<=80 (code points)",
        consistentUnits: false,
      },
      {
        field: "profiles.biggest_problem",
        client: "vocabulary",
        edge: "sanitizeUserText(·,1000) then .length<=256 (UTF-16)",
        db: "length<=500 (code points)",
        consistentUnits: false,
      },
      {
        field: "account_deletion_feedback.details",
        client: "ACCOUNT_DELETION_DETAILS_MAX=500 (UTF-16 units)",
        edge: "sanitizeUserText(·,500) (code points)",
        db: "length<=1000 (code points)",
        consistentUnits: false,
      },
      {
        field: "consent_records.consent_version",
        client: "constant",
        edge: "sanitizeUserText(·,64) (code points)",
        db: "length<=50 (code points)",
        consistentUnits: true,
        edgeExceedsDb: true,
      },
      {
        field: "consent_records.capture_mode",
        client: "constant",
        edge: "sanitizeUserText(·,64) (code points)",
        db: "length<=50 (code points)",
        consistentUnits: true,
        edgeExceedsDb: true,
      },
      {
        field: "consent_records.device",
        client: "device string",
        edge: "sanitizeUserText(·,512) (code points ≤ 2048 bytes)",
        db: "pg_column_size<=4096 (bytes)",
        consistentUnits: false,
        edgeExceedsDb: false,
      },
      {
        field: "shots.shot_type",
        client: "vocabulary",
        edge: ".length<=64 (UTF-16 units), unsanitized",
        db: "length<=64 (code points)",
        consistentUnits: false,
      },
      {
        field: "shot_checkpoints.direction",
        client: "vocabulary",
        edge: ".length<=64 (UTF-16 units), unsanitized",
        db: "length<=64 (code points)",
        consistentUnits: false,
      },
      {
        field: "request body",
        client: "n/a",
        edge: "5_000_000 bytes (streamed)",
        db: "n/a",
        consistentUnits: true,
      },
    ];
    writeArtifact("cap_parity_table.json", table);
    assertEquals(
      table.filter((r) => r.edgeExceedsDb).map((r) => r.field),
      ["consent_records.consent_version", "consent_records.capture_mode"],
    );
    assertEquals(CLIENT_FIRST_NAME_MAX_U16, SERVER_FIRST_NAME_MAX_U16);
    assert(
      CLUSTERS.some((c) => c.text.length > 13),
      "corpus contains a single grapheme wider than 13 UTF-16 units (3 of them exceed 40)",
    );
  },
);
