// Seeded generators for the `PUT /v1/me/onboarding` fuzz/boundary campaign.
//
// `caseFor(seed, index)` is a pure function: the same (seed, index) always
// yields the same request AND the same expectation, so any failure replays
// with `STRESS_SEED=<seed> STRESS_ITER=<n>` (or the single-case filter the
// test prints). Expectations are deliberately coarse where the contract is
// coarse:
//
//   accept — a well-formed, authenticated PUT on the exact route: 200, exactly
//            one profiles PATCH, only whitelisted columns.
//   reject — bad input: one of 400/401/403/404/405/413/415/429, no write.
//   either — inputs whose acceptance is a legitimate routing/parsing detail
//            (duplicate JSON keys, an arbitrary gateway prefix, a path that
//            URL-normalises back onto the route): whichever way it lands, the
//            landing must be a valid one (200 + a whitelisted write, or a
//            reject status + no write).

import {
  type Fault,
  GENDER_OPTIONS,
  GOAL_FOCUS,
  providerIdToken,
  type Rng,
  rngFor,
  sanitize,
  sessionAccessToken,
} from "./stress_onboarding_harness.ts";

export type Expectation = "accept" | "reject" | "either";

export interface FuzzCase {
  seed: number;
  index: number;
  expect: Expectation;
  method: string;
  url: string;
  routePath: string;
  headers: Record<string, string>;
  rawBody?: string;
  bodyBytes: number;
  fault: Fault;
  labels: {
    auth: string;
    method: string;
    path: string;
    query: string;
    body: string;
    contentType: string;
    requestId: string;
    fault: Fault;
  };
  ip: string;
  sub: string;
  requestIdIn: string | null;
  requestIdValidIn: boolean;
  /** For an `accept` case: the patch the route must write. */
  expectedPatch?: Record<string, unknown>;
  expectedFocus?: string;
}

const BASE = "http://edge.stress.test";
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

const hex = (rng: Rng, n: number): string =>
  Array.from({ length: n }, () => "0123456789abcdef"[rng.int(16)]).join("");

function uuidFrom(rng: Rng): string {
  return `${hex(rng, 8)}-${hex(rng, 4)}-4${hex(rng, 3)}-8${hex(rng, 3)}-${
    hex(rng, 12)
  }`;
}

const CONTROL_SOUP = "\u0000\u0007\u001b\u009f\u200b\u200e\u202e\u2066\ufeff";
const ASTRAL = "🏓";
const rep = (unit: string, times: number): string => unit.repeat(times);

/** Auth header shapes, with whether authenticate() must accept them. */
function authHeader(
  rng: Rng,
  sub: string,
): { label: string; header: string | null; valid: boolean } {
  const roll = rng.next();
  if (roll < 0.52) {
    return {
      label: "provider_id_token",
      header: `Bearer ${providerIdToken(sub)}`,
      valid: true,
    };
  }
  if (roll < 0.68) {
    return {
      label: "session_access_token",
      header: `Bearer ${sessionAccessToken(sub)}`,
      valid: true,
    };
  }
  if (roll < 0.72) return { label: "missing", header: null, valid: false };
  if (roll < 0.76) {
    return { label: "empty_bearer", header: "Bearer ", valid: false };
  }
  if (roll < 0.79) {
    return {
      label: "basic_scheme",
      header: "Basic dXNlcjpwYXNz",
      valid: false,
    };
  }
  if (roll < 0.82) {
    return {
      label: "garbage_jwt",
      header: `Bearer ${hex(rng, 40)}`,
      valid: false,
    };
  }
  if (roll < 0.85) {
    return {
      label: "expired_provider",
      header: `Bearer ${providerIdToken(sub, { expOffsetSeconds: -600 })}`,
      valid: false,
    };
  }
  if (roll < 0.88) {
    return {
      label: "wrong_issuer",
      header: `Bearer ${
        providerIdToken(sub, { iss: "https://evil.example.com" })
      }`,
      valid: false,
    };
  }
  if (roll < 0.91) {
    return {
      label: "provider_no_sub",
      header: `Bearer ${providerIdToken(sub, { dropSub: true })}`,
      valid: false,
    };
  }
  if (roll < 0.94) {
    return {
      label: "session_expired",
      header: `Bearer ${sessionAccessToken(sub, { expOffsetSeconds: -60 })}`,
      valid: false,
    };
  }
  if (roll < 0.97) {
    return {
      label: "huge_bearer",
      header: `Bearer ${rep("A", 8_000)}`,
      valid: false,
    };
  }
  return { label: "bearer_only_dots", header: "Bearer ..", valid: false };
}

function methodFor(rng: Rng): { label: string; method: string } {
  const roll = rng.next();
  if (roll < 0.84) return { label: "PUT", method: "PUT" };
  const method = rng.pick([
    "POST",
    "PATCH",
    "GET",
    "DELETE",
    "OPTIONS",
    "HEAD",
  ]);
  return { label: method, method };
}

function pathFor(rng: Rng): { label: string; path: string } {
  const roll = rng.next();
  if (roll < 0.6) {
    return { label: "canonical", path: "/functions/v1/api/v1/me/onboarding" };
  }
  if (roll < 0.66) {
    return { label: "gateway_stripped", path: "/api/v1/me/onboarding" };
  }
  if (roll < 0.70) return { label: "bare", path: "/v1/me/onboarding" };
  if (roll < 0.74) {
    return {
      label: "trailing_slash",
      path: "/functions/v1/api/v1/me/onboarding/",
    };
  }
  if (roll < 0.78) {
    return {
      label: "extra_segment",
      path: "/functions/v1/api/v1/me/onboarding/extra",
    };
  }
  if (roll < 0.81) {
    return { label: "uppercase", path: "/functions/v1/api/v1/me/ONBOARDING" };
  }
  if (roll < 0.84) {
    return {
      label: "double_slash",
      path: "/functions/v1/api/v1/me//onboarding",
    };
  }
  if (roll < 0.87) {
    return {
      label: "percent_encoded",
      path: "/functions/v1/api/v1/me/onboard%69ng",
    };
  }
  if (roll < 0.90) {
    return {
      label: "traversal",
      path: "/functions/v1/api/v1/me/onboarding/../onboarding",
    };
  }
  if (roll < 0.92) {
    return {
      label: "interior_v1",
      path: "/functions/v1/api/v1/me/v1/me/onboarding",
    };
  }
  if (roll < 0.94) {
    return { label: "unicode", path: "/functions/v1/api/v1/me/onboardíng" };
  }
  if (roll < 0.96) {
    return {
      label: "long_segment",
      path: `/functions/v1/api/v1/me/${rep("z", 4_000)}`,
    };
  }
  if (roll < 0.98) {
    return {
      label: "encoded_nul",
      path: "/functions/v1/api/v1/me/onboarding%00",
    };
  }
  return { label: "sibling_route", path: "/functions/v1/api/v1/me/profile" };
}

function queryFor(rng: Rng): { label: string; query: string } {
  const roll = rng.next();
  if (roll < 0.7) return { label: "none", query: "" };
  if (roll < 0.75) return { label: "select_star", query: "?select=*" };
  if (roll < 0.80) {
    return {
      label: "field_override",
      query: "?handedness=left&skillLevel=pro",
    };
  }
  if (roll < 0.84) {
    return {
      label: "postgrest_filter",
      query: "?id=eq.00000000-0000-4000-8000-000000000000",
    };
  }
  if (roll < 0.88) {
    return { label: "unicode", query: "?q=%F0%9F%8F%93&bidi=%E2%80%AE" };
  }
  if (roll < 0.92) return { label: "encoded_nul", query: "?q=%00" };
  if (roll < 0.96) {
    return {
      label: "many_params",
      query: `?${
        Array.from({ length: 200 }, (_, i) => `p${i}=${i}`).join("&")
      }`,
    };
  }
  return { label: "huge_param", query: `?blob=${rep("x", 20_000)}` };
}

function contentTypeFor(rng: Rng): { label: string; value: string | null } {
  const roll = rng.next();
  if (roll < 0.74) {
    return { label: "application/json", value: "application/json" };
  }
  if (roll < 0.80) return { label: "none", value: null };
  if (roll < 0.85) return { label: "text/plain", value: "text/plain" };
  if (roll < 0.89) {
    return { label: "form", value: "application/x-www-form-urlencoded" };
  }
  if (roll < 0.93) {
    return { label: "multipart", value: "multipart/form-data; boundary=x" };
  }
  if (roll < 0.97) {
    return {
      label: "json_odd_charset",
      value: "application/json; charset=utf-7",
    };
  }
  return { label: "xml", value: "application/xml" };
}

function requestIdFor(rng: Rng): { label: string; value: string | null } {
  const roll = rng.next();
  if (roll < 0.7) return { label: "absent", value: null };
  if (roll < 0.82) return { label: "valid", value: `stress-${hex(rng, 12)}` };
  if (roll < 0.86) return { label: "too_short", value: "abc" };
  if (roll < 0.90) return { label: "too_long", value: rep("a", 200) };
  if (roll < 0.94) return { label: "spaces", value: "id with spaces" };
  // Header values must stay ByteString-legal (≤ U+00FF) — a real client
  // cannot put astral characters in a header either.
  if (roll < 0.97) {
    return { label: "latin1_accents", value: "id-caf\u00e9-\u00ff" };
  }
  return { label: "html", value: '"><script>alert(1)</script>' };
}

interface FieldPick {
  value: unknown;
  present: boolean;
  label: string;
}

function skillLevelPick(rng: Rng): FieldPick {
  const roll = rng.next();
  if (roll < 0.42) {
    return {
      value: rng.pick([
        "beginner",
        "intermediate",
        "advanced",
        "3.0",
        "4.5",
        "just started",
      ]),
      present: true,
      label: "valid",
    };
  }
  if (roll < 0.48) {
    return { value: rep("a", 64), present: true, label: "len64" };
  }
  if (roll < 0.54) {
    return { value: rep("a", 65), present: true, label: "len65" };
  }
  if (roll < 0.58) {
    return { value: rep("a", 5_000), present: true, label: "len5000" };
  }
  if (roll < 0.62) return { value: "", present: true, label: "empty" };
  if (roll < 0.66) {
    return { value: "   \t\n ", present: true, label: "whitespace" };
  }
  if (roll < 0.70) {
    return { value: CONTROL_SOUP, present: true, label: "control_only" };
  }
  if (roll < 0.74) {
    return { value: rep(ASTRAL, 33), present: true, label: "astral33" };
  }
  if (roll < 0.78) {
    return { value: rep(ASTRAL, 20), present: true, label: "astral20" };
  }
  if (roll < 0.82) {
    return { value: "\ud800lone", present: true, label: "lone_surrogate" };
  }
  if (roll < 0.86) return { value: 3.5, present: true, label: "number" };
  if (roll < 0.89) return { value: true, present: true, label: "boolean" };
  if (roll < 0.92) return { value: null, present: true, label: "null" };
  if (roll < 0.95) {
    return { value: ["intermediate"], present: true, label: "array" };
  }
  if (roll < 0.98) {
    return { value: { level: "pro" }, present: true, label: "object" };
  }
  return { value: undefined, present: false, label: "absent" };
}

function handednessPick(rng: Rng): FieldPick {
  const roll = rng.next();
  if (roll < 0.5) {
    return {
      value: rng.pick(["right", "left"]),
      present: true,
      label: "valid",
    };
  }
  if (roll < 0.58) return { value: "RIGHT", present: true, label: "uppercase" };
  if (roll < 0.64) {
    return { value: "right ", present: true, label: "trailing_space" };
  }
  if (roll < 0.70) {
    return { value: "ambidextrous", present: true, label: "unknown" };
  }
  if (roll < 0.75) return { value: "", present: true, label: "empty" };
  if (roll < 0.80) return { value: null, present: true, label: "null" };
  if (roll < 0.85) return { value: 1, present: true, label: "number" };
  if (roll < 0.90) return { value: ["right"], present: true, label: "array" };
  if (roll < 0.94) {
    return { value: { hand: "right" }, present: true, label: "object" };
  }
  if (roll < 0.97) {
    return { value: "righ\u200bt", present: true, label: "zero_width" };
  }
  return { value: undefined, present: false, label: "absent" };
}

function goalPick(rng: Rng): FieldPick {
  const roll = rng.next();
  if (roll < 0.42) {
    return {
      value: rng.pick(Object.keys(GOAL_FOCUS)),
      present: true,
      label: "known",
    };
  }
  if (roll < 0.52) {
    return { value: "chop-shots", present: true, label: "unknown_goal" };
  }
  if (roll < 0.58) {
    return { value: rep("g", 64), present: true, label: "len64" };
  }
  if (roll < 0.64) {
    return { value: rep("g", 65), present: true, label: "len65" };
  }
  if (roll < 0.70) return { value: "", present: true, label: "empty" };
  if (roll < 0.74) {
    return { value: CONTROL_SOUP, present: true, label: "control_only" };
  }
  if (roll < 0.79) {
    return { value: rep(ASTRAL, 33), present: true, label: "astral33" };
  }
  if (roll < 0.84) {
    return { value: "  dinks  ", present: true, label: "padded" };
  }
  if (roll < 0.88) return { value: 7, present: true, label: "number" };
  if (roll < 0.92) return { value: null, present: true, label: "null" };
  if (roll < 0.96) return { value: ["dinks"], present: true, label: "array" };
  return { value: undefined, present: false, label: "absent" };
}

function biggestProblemPick(rng: Rng): FieldPick {
  const roll = rng.next();
  if (roll < 0.40) {
    return {
      value: rng.pick([
        "I pop dinks up at the kitchen line",
        "my third shot drop floats",
        "backhand volleys die",
      ]),
      present: true,
      label: "valid",
    };
  }
  if (roll < 0.47) {
    return { value: rep("b", 256), present: true, label: "len256" };
  }
  if (roll < 0.54) {
    return { value: rep("b", 257), present: true, label: "len257" };
  }
  if (roll < 0.59) {
    return { value: rep("b", 1_000), present: true, label: "len1000" };
  }
  if (roll < 0.64) {
    return { value: rep("b", 200_000), present: true, label: "len200k" };
  }
  if (roll < 0.68) return { value: "", present: true, label: "empty" };
  if (roll < 0.72) {
    return { value: CONTROL_SOUP, present: true, label: "control_only" };
  }
  if (roll < 0.77) {
    return {
      value: `I lose${CONTROL_SOUP}dinks`,
      present: true,
      label: "control_mixed",
    };
  }
  if (roll < 0.82) {
    return { value: rep(ASTRAL, 129), present: true, label: "astral129" };
  }
  if (roll < 0.86) {
    return { value: rep(ASTRAL, 100), present: true, label: "astral100" };
  }
  if (roll < 0.90) return { value: 42, present: true, label: "number" };
  if (roll < 0.94) return { value: null, present: true, label: "null" };
  if (roll < 0.97) {
    return { value: { text: "x" }, present: true, label: "object" };
  }
  return { value: undefined, present: false, label: "absent" };
}

function firstNamePick(rng: Rng): FieldPick {
  const roll = rng.next();
  if (roll < 0.30) return { value: undefined, present: false, label: "absent" };
  if (roll < 0.38) return { value: null, present: true, label: "null" };
  if (roll < 0.50) {
    return {
      value: rng.pick(["Al", "Raunak", "María", "李雷"]),
      present: true,
      label: "valid",
    };
  }
  if (roll < 0.56) {
    return { value: rep("n", 40), present: true, label: "len40" };
  }
  if (roll < 0.62) {
    return { value: rep("n", 41), present: true, label: "len41" };
  }
  if (roll < 0.67) {
    return { value: rep("n", 500), present: true, label: "len500" };
  }
  if (roll < 0.72) return { value: "", present: true, label: "empty" };
  if (roll < 0.77) return { value: "   ", present: true, label: "whitespace" };
  if (roll < 0.82) {
    return { value: CONTROL_SOUP, present: true, label: "control_only" };
  }
  if (roll < 0.86) {
    return { value: rep(ASTRAL, 21), present: true, label: "astral21" };
  }
  if (roll < 0.90) {
    return { value: rep(ASTRAL, 15), present: true, label: "astral15" };
  }
  if (roll < 0.94) return { value: 7, present: true, label: "number" };
  if (roll < 0.97) return { value: ["Al"], present: true, label: "array" };
  return { value: { first: "Al" }, present: true, label: "object" };
}

function genderPick(rng: Rng): FieldPick {
  const roll = rng.next();
  if (roll < 0.32) return { value: undefined, present: false, label: "absent" };
  if (roll < 0.40) return { value: null, present: true, label: "null" };
  if (roll < 0.62) {
    return {
      value: rng.pick([...GENDER_OPTIONS]),
      present: true,
      label: "valid",
    };
  }
  if (roll < 0.70) return { value: "Male", present: true, label: "wrong_case" };
  if (roll < 0.76) {
    return { value: "male ", present: true, label: "trailing_space" };
  }
  if (roll < 0.82) return { value: "other", present: true, label: "unknown" };
  if (roll < 0.87) return { value: "", present: true, label: "empty" };
  if (roll < 0.92) return { value: 1, present: true, label: "number" };
  if (roll < 0.96) return { value: ["male"], present: true, label: "array" };
  return {
    value: "prefer_not_to_say\u200b",
    present: true,
    label: "zero_width",
  };
}

/** All-valid field draws. Without this bias the joint probability of six
 * independently-valid fields is ~2%, so the accepted path — where the write
 * whitelist, sanitization and the DB caps are checked — would barely run. */
function validPicks(rng: Rng): Record<string, FieldPick> {
  const optional = (value: unknown, label: string): FieldPick =>
    rng.next() < 0.25
      ? { value: undefined, present: false, label: "absent" }
      : { value, present: true, label };
  return {
    skill: {
      value: rng.pick([
        "beginner",
        "intermediate",
        "advanced",
        "3.0",
        "4.5",
        rep("a", 64),
        `  padded ${ASTRAL} level  `,
        `skill${CONTROL_SOUP}level`,
      ]),
      present: true,
      label: "valid",
    },
    hand: { value: rng.pick(["right", "left"]), present: true, label: "valid" },
    goal: {
      value: rng.pick([
        ...Object.keys(GOAL_FOCUS),
        "chop-shots",
        "  dinks  ",
        rep("g", 64),
      ]),
      present: true,
      label: "valid",
    },
    problem: {
      value: rng.pick([
        "I pop dinks up at the kitchen line",
        rep("b", 256),
        `I lose dinks${CONTROL_SOUP}at the kitchen`,
        rep(ASTRAL, 100),
      ]),
      present: true,
      label: "valid",
    },
    first: optional(
      rng.pick([
        "Al",
        "Raunak",
        "María",
        "李雷",
        rep("n", 40),
        `Al${CONTROL_SOUP}i`,
      ]),
      "valid",
    ),
    gender: optional(rng.pick([...GENDER_OPTIONS]), "valid"),
  };
}

/** Keys an attacker would love the route to forward to PostgREST. */
function extraKeys(rng: Rng): Record<string, unknown> {
  const pool: Array<[string, unknown]> = [
    ["id", "00000000-0000-4000-8000-000000000000"],
    ["user_id", "00000000-0000-4000-8000-000000000000"],
    ["email", "attacker@example.com"],
    ["is_premium", true],
    ["premium", true],
    ["onboarding_state", "pending"],
    ["focus_checkpoint", "hacked_checkpoint"],
    ["role", "service_role"],
    ["scored_count", 99],
    ["skill_level", "sql-injected"],
    ["primary_goal", "sql-injected"],
    ["biggest_problem", "sql-injected"],
    ["created_at", "1970-01-01T00:00:00.000Z"],
    ["__proto__", { handedness: "left", is_premium: true }],
    ["constructor", { prototype: { polluted: true } }],
    ["prototype", { polluted: true }],
    ["select", "*"],
    ["nested", { a: { b: { c: { d: [1, 2, 3] } } } }],
    ["huge", Array.from({ length: 500 }, (_, i) => i)],
  ];
  const out: Record<string, unknown> = {};
  const count = 1 + rng.int(4);
  for (let i = 0; i < count; i += 1) {
    const [k, v] = rng.pick(pool);
    // defineProperty, not assignment: `out.__proto__ = …` would set the
    // prototype instead of producing a literal "__proto__" JSON key.
    Object.defineProperty(out, k, {
      value: v,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

const validText = (value: unknown, cap: number, max: number): string | null => {
  if (typeof value !== "string") return null;
  const cleaned = sanitize(value, cap);
  if (!cleaned || cleaned.length > max) return null;
  return cleaned;
};

/** Raw (non-object / malformed / adversarial) bodies. Acceptance of these is
 * a parser detail, so they are `either` cases. */
function rawBodyFor(rng: Rng): { label: string; body: string | undefined } {
  const valid = JSON.stringify({
    skillLevel: "intermediate",
    handedness: "right",
    goal: "dinks",
    biggestProblem: "I pop dinks up",
  });
  const roll = rng.next();
  if (roll < 0.07) return { label: "absent", body: undefined };
  if (roll < 0.14) return { label: "empty_string", body: "" };
  if (roll < 0.20) return { label: "literal_null", body: "null" };
  if (roll < 0.26) return { label: "array", body: "[1,2,3]" };
  if (roll < 0.32) return { label: "scalar_string", body: '"intermediate"' };
  if (roll < 0.37) return { label: "scalar_number", body: "1e309" };
  if (roll < 0.42) return { label: "truncated_object", body: '{"skillLevel":' };
  if (roll < 0.47) {
    return { label: "trailing_comma", body: '{"skillLevel":"a",}' };
  }
  if (roll < 0.52) {
    return { label: "single_quotes", body: "{'skillLevel':'a'}" };
  }
  if (roll < 0.57) return { label: "nan", body: '{"skillLevel":NaN}' };
  if (roll < 0.62) return { label: "bom_prefixed", body: `\ufeff${valid}` };
  if (roll < 0.67) {
    return {
      label: "duplicate_keys",
      body:
        '{"skillLevel":"a","skillLevel":"intermediate","handedness":"nope","handedness":"left",' +
        '"goal":"dinks","biggestProblem":"dinks pop up"}',
    };
  }
  if (roll < 0.72) {
    return {
      label: "deep_nesting",
      body: `${rep("[", 5_000)}1${rep("]", 5_000)}`,
    };
  }
  if (roll < 0.77) {
    return { label: "form_encoded", body: "skillLevel=a&handedness=right" };
  }
  if (roll < 0.82) {
    return { label: "binary_ish", body: "\u0000\u0001\u0002\u0003" };
  }
  if (roll < 0.87) {
    return {
      label: "big_string_1mb",
      body: JSON.stringify({ skillLevel: rep("x", 1_000_000) }),
    };
  }
  if (roll < 0.92) {
    return {
      label: "many_keys",
      body: JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 5_000 }, (_, i) => [`k${i}`, i]),
        ),
      ),
    };
  }
  if (roll < 0.96) {
    return { label: "unicode_keys", body: '{"skillLevel\u202e":"a","🏓":"b"}' };
  }
  return { label: "json_in_string", body: JSON.stringify(valid) };
}

export function caseFor(seed: number, index: number): FuzzCase {
  const rng = rngFor(seed ^ (index * 0x9e3779b1));
  const sub = uuidFrom(rng);
  // A distinct client IP per iteration: per-IP budgets (1200/60s) and the
  // auth-failure budget (30/300s) are not what this lens measures.
  const ip = `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;

  const auth = authHeader(rng, sub);
  const method = methodFor(rng);
  const path = pathFor(rng);
  const query = queryFor(rng);
  const contentType = contentTypeFor(rng);
  const requestId = requestIdFor(rng);

  const faultRoll = rng.next();
  const fault: Fault = faultRoll < 0.93
    ? "none"
    : faultRoll < 0.955
    ? "db_500_hostile_detail"
    : faultRoll < 0.975
    ? "db_zero_rows"
    : faultRoll < 0.99
    ? "db_column_grant_denied"
    : "auth_500";

  const structured = rng.next() < 0.62;
  let rawBody: string | undefined;
  let bodyLabel: string;
  let expectedPatch: Record<string, unknown> | undefined;
  let bodyValid = false;

  if (structured) {
    const valid = rng.next() < 0.42 ? validPicks(rng) : null;
    const skill = valid ? valid.skill : skillLevelPick(rng);
    const hand = valid ? valid.hand : handednessPick(rng);
    const goal = valid ? valid.goal : goalPick(rng);
    const problem = valid ? valid.problem : biggestProblemPick(rng);
    const first = valid ? valid.first : firstNamePick(rng);
    const gender = valid ? valid.gender : genderPick(rng);
    const withExtras = rng.next() < 0.3;

    const body: Record<string, unknown> = {};
    if (withExtras) {
      for (const [k, v] of Object.entries(extraKeys(rng))) {
        Object.defineProperty(body, k, {
          value: v,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    if (skill.present) body.skillLevel = skill.value;
    if (hand.present) body.handedness = hand.value;
    if (goal.present) body.goal = goal.value;
    if (problem.present) body.biggestProblem = problem.value;
    if (first.present) body.firstName = first.value;
    if (gender.present) body.gender = gender.value;

    bodyLabel = [
      `skill:${skill.label}`,
      `hand:${hand.label}`,
      `goal:${goal.label}`,
      `problem:${problem.label}`,
      `first:${first.label}`,
      `gender:${gender.label}`,
      withExtras ? "extras" : "no_extras",
    ].join("|");

    const cleanSkill = validText(skill.value, 200, 64);
    const cleanGoal = validText(goal.value, 200, 64);
    const cleanProblem = validText(problem.value, 1_000, 256);
    const handOk = hand.value === "right" || hand.value === "left";
    let firstOk = true;
    let cleanFirst: string | undefined;
    if (first.present && first.value !== null && first.value !== undefined) {
      const cleaned = typeof first.value === "string"
        ? sanitize(first.value, 200)
        : null;
      if (cleaned === null || cleaned.length < 1 || cleaned.length > 40) {
        firstOk = false;
      } else cleanFirst = cleaned;
    }
    let genderOk = true;
    let cleanGender: string | undefined;
    if (gender.present && gender.value !== null && gender.value !== undefined) {
      if (
        typeof gender.value !== "string" || !GENDER_OPTIONS.has(gender.value)
      ) genderOk = false;
      else cleanGender = gender.value;
    }
    bodyValid = Boolean(
      cleanSkill && cleanGoal && cleanProblem && handOk && firstOk && genderOk,
    );
    rawBody = JSON.stringify(body);
    if (bodyValid) {
      const focus = GOAL_FOCUS[cleanGoal as string] ?? "contact_position";
      expectedPatch = {
        skill_level: cleanSkill,
        handedness: hand.value,
        primary_goal: cleanGoal,
        biggest_problem: cleanProblem,
        focus_checkpoint: focus,
        onboarding_state: "complete",
        ...(cleanFirst !== undefined ? { first_name: cleanFirst } : {}),
        ...(cleanGender !== undefined ? { gender: cleanGender } : {}),
      };
    }
  } else {
    const raw = rawBodyFor(rng);
    rawBody = raw.body;
    bodyLabel = `raw:${raw.label}`;
  }

  const headers: Record<string, string> = { "x-forwarded-for": ip };
  if (auth.header !== null) headers.Authorization = auth.header;
  if (contentType.value !== null) headers["Content-Type"] = contentType.value;
  if (requestId.value !== null) headers["x-request-id"] = requestId.value;

  // A declared content-length above the 5 MB cap must be refused before any
  // work — with a tiny real body, so the lie is the only signal.
  const clLie = rng.next() < 0.02;
  if (clLie) headers["content-length"] = "6000000";

  const url = `${BASE}${path.path}${query.query}`;
  const parsed = new URL(url);
  const v1 = parsed.pathname.lastIndexOf("/v1/");
  const routePath = v1 >= 0 ? parsed.pathname.slice(v1) : parsed.pathname;

  const bodyBytes = rawBody === undefined
    ? 0
    : new TextEncoder().encode(rawBody).byteLength;
  const onRoute = routePath === "/v1/me/onboarding" && method.method === "PUT";
  const oversize = bodyBytes > 5_000_000 || clLie;

  let expect: Expectation;
  if (!onRoute || !auth.valid || oversize) expect = "reject";
  else if (structured) expect = bodyValid ? "accept" : "reject";
  else expect = "either";

  return {
    seed,
    index,
    expect,
    method: method.method,
    url,
    routePath,
    headers,
    rawBody,
    bodyBytes,
    fault,
    labels: {
      auth: auth.label,
      method: method.label,
      path: path.label,
      query: query.label,
      body: bodyLabel,
      contentType: contentType.label + (clLie ? "|content_length_lie" : ""),
      requestId: requestId.label,
      fault,
    },
    ip,
    sub,
    requestIdIn: requestId.value,
    requestIdValidIn: requestId.value !== null &&
      REQUEST_ID_RE.test(requestId.value.trim()),
    expectedPatch,
    expectedFocus: expectedPatch?.focus_checkpoint as string | undefined,
  };
}

export function requestFor(c: FuzzCase): Request {
  const init: RequestInit = { method: c.method, headers: c.headers };
  if (c.rawBody !== undefined && c.method !== "GET" && c.method !== "HEAD") {
    init.body = c.rawBody;
  }
  return new Request(c.url, init);
}
