/**
 * Seeded input generators for the boundary/malformed-input stress campaign.
 *
 * Everything here is SYNTHETIC: random strings, numbers and structures built
 * from a seed. No production telemetry, no real users, no real device data.
 */
import { CHECKPOINTS, SHOT_TYPES } from "@pickle/shared-types";
import {
  ABSTENTION_REASON_CATEGORIES,
  ANALYTICS_EVENT_NAMES,
  type AnalyticsEvent,
  type AnalyticsEventName,
} from "../../src/index.js";
import type { DriftObservation } from "../../src/drift.js";
import {
  ASCII_PRINTABLE,
  ASCII_WORD,
  ASTRAL,
  COMBINING,
  CONTROL_CHARS,
  SeededRng,
} from "./seededRng.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Malformed = Record<string, unknown>;

const ISO_AT = "2026-09-04T12:00:00.000Z";

function word(rng: SeededRng, max = 24): string {
  return rng.string(rng.int(1, max), ASCII_WORD);
}

/** A well-formed member of the AnalyticsEvent union, chosen and filled from the seed. */
export function validEvent(rng: SeededRng): AnalyticsEvent {
  const base = {
    at: ISO_AT,
    ...(rng.bool() ? { sessionId: word(rng, 32) } : {}),
    ...(rng.bool()
      ? { appBuild: `${rng.int(1, 9)}.${rng.int(0, 20)}.${rng.int(0, 9)} (${rng.int(1, 999)})` }
      : {}),
    ...(rng.bool() ? { platform: rng.pick(["ios", "android", "service"] as const) } : {}),
    ...(rng.bool()
      ? { deviceClass: rng.pick(["phone_high", "phone_mid", "phone_low", "tablet", "server"]) }
      : {}),
  };
  const name: AnalyticsEventName = rng.pick(ANALYTICS_EVENT_NAMES);
  const shotType = rng.pick(SHOT_TYPES);
  const checkpoint = rng.pick(CHECKPOINTS);
  switch (name) {
    case "app_opened":
    case "onboarding_started":
    case "camera_preflight_started":
    case "weekly_review_viewed":
    case "friend_request_sent":
    case "account_export_requested":
    case "account_delete_requested":
    case "worker_started":
      return { ...base, name };
    case "onboarding_completed":
      return { ...base, name, skillLevel: word(rng), handedness: rng.pick(["right", "left"]) };
    case "goal_selected":
      return { ...base, name, goal: word(rng) };
    case "shot_type_selected":
    case "shot_detected":
    case "analysis_low_confidence":
    case "score_viewed":
      return { ...base, name, shotType };
    case "camera_preflight_passed":
      return { ...base, name, attempts: rng.int(1, 10) };
    case "capture_started":
      return { ...base, name, mode: rng.pick(["single", "live", "import"] as const) };
    case "analysis_started":
      return {
        ...base,
        name,
        inferenceMode: rng.pick(["on_device", "cloud_deep"] as const),
        ...(rng.bool() ? { modelVersion: word(rng) } : {}),
      };
    case "analysis_completed":
      return {
        ...base,
        name,
        shotType,
        confidenceBand: rng.pick(["normal", "lower"] as const),
        ...(rng.bool() ? { latencyMs: rng.int(0, 60_000) } : {}),
        ...(rng.bool() ? { modelVersion: word(rng) } : {}),
      };
    case "analysis_failed":
      return {
        ...base,
        name,
        failureKind: word(rng),
        ...(rng.bool() ? { latencyMs: rng.int(0, 60_000) } : {}),
      };
    case "analysis_abstained":
      return {
        ...base,
        name,
        reasonCategory: rng.pick(ABSTENTION_REASON_CATEGORIES),
        ...(rng.bool() ? { latencyMs: rng.int(0, 60_000) } : {}),
      };
    case "capture_envelope_verdict":
      return {
        ...base,
        name,
        overall: rng.pick(["SUPPORTED", "DEGRADED", "UNSUPPORTED"] as const),
        failedDimensions: Array.from({ length: rng.int(0, 8) }, () => word(rng, 16)),
        notMeasuredCount: rng.int(0, 8),
        thresholdsVersion: `v${rng.int(0, 3)}.${rng.int(0, 9)}`,
      };
    case "target_lock_failed":
      return {
        ...base,
        name,
        reason: rng.pick(["no_lock", "ambiguity_timeout"] as const),
        ambiguityEntered: rng.bool(),
        ...(rng.bool() ? { timeToFailMs: rng.int(0, 10_000) } : {}),
        algorithmVersion: `D-${rng.int(1, 99)}`,
      };
    case "event_proposal_failed":
      return {
        ...base,
        name,
        reasonCategory: rng.pick(["no_event_proposed", "event_rejected"] as const),
      };
    case "app_crash":
      return { ...base, name, fingerprint: rng.string(12, "0123456789abcdef"), fatal: rng.bool() };
    case "worker_failure":
      return { ...base, name, jobKind: word(rng), failureKind: word(rng) };
    case "queue_backlog":
      return {
        ...base,
        name,
        queue: word(rng),
        depth: rng.int(0, 10_000),
        ...(rng.bool() ? { oldestJobAgeMs: rng.int(0, 1e7) } : {}),
      };
    case "queue_stalled":
      return {
        ...base,
        name,
        queue: word(rng),
        reason: rng.pick(["no_progress", "oldest_job_age_exceeded"] as const),
        depth: rng.int(0, 10_000),
        consecutiveIdleCycles: rng.int(0, 100),
      };
    case "worker_crash":
      return { ...base, name, crashCount: rng.int(0, 100) };
    case "deletion_backlog":
      return { ...base, name, pending: rng.int(0, 1000), exhausted: rng.int(0, 50) };
    case "media_storage_failure":
      return { ...base, name, operation: rng.pick(["purge", "sweep", "transcode"] as const) };
    case "api_failure":
      return {
        ...base,
        name,
        route: `/v1/${word(rng, 12)}/:id`,
        method: rng.pick(["GET", "POST", "PUT", "DELETE"]),
        statusCode: rng.pick([401, 403, 500, 502, 503]),
        errorCode: word(rng),
        ...(rng.bool() ? { flagStateHash: rng.string(16, "0123456789abcdef") } : {}),
      };
    case "checkpoint_opened":
      return { ...base, name, checkpoint };
    case "drill_opened":
    case "drill_started":
    case "drill_completed":
      return { ...base, name, drillSlug: word(rng) };
    case "live_court_started":
      return { ...base, name, shotType, focus: checkpoint };
    case "live_shot_scored":
      return { ...base, name, repIndex: rng.int(0, 500) };
    case "voice_cue_played":
      return { ...base, name, category: word(rng) };
    case "live_session_completed":
      return { ...base, name, validShots: rng.int(0, 500), durationSec: rng.int(0, 7200) };
    case "share_created":
      return { ...base, name, templateKey: word(rng) };
    case "paywall_viewed":
      return { ...base, name, placement: word(rng) };
    case "trial_started":
    case "subscription_started":
    case "subscription_renewed":
    case "subscription_cancelled":
      return { ...base, name, productKey: word(rng) };
    case "cloud_sync_enabled":
      return { ...base, name, enabled: rng.bool() };
    case "ml_training_consent_changed":
      return { ...base, name, granted: rng.bool() };
  }
}

/** Committed PII/media fixtures the redaction guard must always flag. */
export const PII_FIXTURES: ReadonlyArray<{ payload: string; rule: string }> = [
  {
    payload: "file:///var/mobile/Containers/Data/Application/ABC/tmp/clip.mov",
    rule: "uri_scheme",
  },
  { payload: "content://media/external/video/media/42", rule: "uri_scheme" },
  { payload: "ph://ABCDEF-1234/L0/001", rule: "uri_scheme" },
  { payload: "s3://pickle-media/user-1/master.mp4", rule: "uri_scheme" },
  { payload: "blob:https://example.invalid/uuid", rule: "uri_scheme" },
  { payload: "blob:6b1e2c3d-0000-4000-8000-000000000000?offset=0&size=1024", rule: "uri_scheme" },
  { payload: "data://text/plain;base64,QUJD", rule: "uri_scheme" },
  { payload: "ENOENT /var/data/media/user-123/master.mp4", rule: "filesystem_path" },
  { payload: "open '/Users/coach/Movies/clip.mov'", rule: "filesystem_path" },
  { payload: "read /private/var/mobile/x.mov", rule: "filesystem_path" },
  { payload: "/tmp/upload-1.bin", rule: "filesystem_path" },
  { payload: "player@example.com", rule: "email_address" },
  { payload: "reply to first.last+tag@sub.example.co.uk", rule: "email_address" },
  { payload: "jos\u00e9@example.com", rule: "email_address" },
  { payload: "coach@ex\u00e4mple.com", rule: "email_address" },
  { payload: "A".repeat(120), rule: "base64_blob" },
  { payload: "iVBORw0KGgo" + "AAAA".repeat(40), rule: "base64_blob" },
];

/** Junk values of the wrong type for any field. */
export function junkValue(rng: SeededRng): unknown {
  switch (rng.int(0, 15)) {
    case 0:
      return null;
    case 1:
      return undefined;
    case 2:
      return rng.pick([
        NaN,
        Infinity,
        -Infinity,
        -0,
        0,
        Number.MAX_VALUE,
        Number.MIN_VALUE,
        2 ** 53 + 1,
        -(2 ** 31),
      ]);
    case 3:
      return rng.bool();
    case 4:
      return BigInt(rng.int(0, 1e9));
    case 5:
      return Symbol(word(rng, 6));
    case 6:
      return () => "fn";
    case 7:
      return new Date(0);
    case 8:
      return new Map([[word(rng, 4), word(rng, 4)]]);
    case 9:
      return [];
    case 10:
      return {};
    case 11:
      return Array.from({ length: rng.int(0, 40) }, () => rng.int(-1000, 1000));
    case 12:
      return { nested: { deeper: { deepest: word(rng) } } };
    case 13:
      return rng.string(rng.int(0, 64), CONTROL_CHARS + ASCII_PRINTABLE);
    case 14:
      return rng.string(rng.int(0, 32), ASTRAL);
    default:
      return word(rng, 300);
  }
}

export const PROTO_KEYS = [
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
] as const;

/** Parse JSON text containing prototype-pollution keys the way an outbox replay would. */
export function protoPollutionEvent(rng: SeededRng): Malformed {
  const key = rng.pick(PROTO_KEYS);
  const marker = `stress_polluted_${rng.int(0, 1e9)}`;
  const text = `{"name":"app_opened","at":"${ISO_AT}","${key}":{"${marker}":1,"polluted":true}}`;
  return { parsed: JSON.parse(text) as Json, marker };
}

export const TRAVERSAL_IDS = [
  "../../etc/passwd",
  "..\\..\\windows\\system32",
  "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
  "....//....//etc/passwd",
  "/etc/passwd",
  "drill\u0000.mov",
  "drill/../../secret",
  "\u2025\u2025/etc/passwd",
];

/** Unicode-normalization pairs: NFC and NFD spellings of the same PII payload. */
export function normalizationPair(rng: SeededRng): { nfc: string; nfd: string } {
  const accented = rng.pick(["é", "ñ", "ü", "å", "ç"]);
  const base = rng.pick([
    `coach${accented}@example.com`,
    `file:///var/mobile/${accented}clip.mov`,
    `ENOENT /Users/jos${accented}/Movies/clip.mov`,
  ]);
  return { nfc: base.normalize("NFC"), nfd: base.normalize("NFD") };
}

/** Confusable / invisible-character variants of PII (guard evasion probes). */
export const CONFUSABLE_VARIANTS: ReadonlyArray<{ payload: string; describes: string }> = [
  { payload: "player\u200B@example.com", describes: "zero-width space before @" },
  { payload: "player\uFF20example.com", describes: "fullwidth @ (U+FF20)" },
  { payload: "file:\u200B///var/mobile/x.mov", describes: "zero-width space after scheme" },
  { payload: "\uFB01le:///var/mobile/x.mov", describes: "ligature fi in scheme" },
  { payload: "failed:/var/mobile/x.mov", describes: "colon-prefixed absolute path" },
  { payload: "/sdcard/DCIM/x.mp4", describes: "unlisted absolute path root" },
  { payload: "FILE:///var/mobile/x.mov", describes: "uppercase scheme" },
  { payload: "file:\\\\var\\mobile\\x.mov", describes: "backslash separators" },
];

/** Build a string that is long by one measure (code units/codepoints/graphemes) and short by another. */
export function lengthBoundaryString(rng: SeededRng): {
  text: string;
  codeUnits: number;
  codepoints: number;
  graphemes: number;
} {
  switch (rng.int(0, 4)) {
    case 0: {
      // 100 astral emoji: 200 code units, 100 codepoints, 100 graphemes.
      const text = rng.string(100, ASTRAL);
      return { text, codeUnits: text.length, codepoints: 100, graphemes: 100 };
    }
    case 1: {
      // 101 astral emoji: 202 code units — one over the cap.
      const text = rng.string(101, ASTRAL);
      return { text, codeUnits: text.length, codepoints: 101, graphemes: 101 };
    }
    case 2: {
      // 40 graphemes each with 5 combining marks: 240 code units, 40 graphemes.
      let text = "";
      for (let i = 0; i < 40; i++) text += rng.pick(Array.from(ASCII_WORD)) + COMBINING;
      return { text, codeUnits: text.length, codepoints: 240, graphemes: 40 };
    }
    case 3: {
      // Exactly at the cap.
      const text = rng.string(200, ASCII_WORD);
      return { text, codeUnits: 200, codepoints: 200, graphemes: 200 };
    }
    default: {
      const text = rng.string(201, ASCII_WORD);
      return { text, codeUnits: 201, codepoints: 201, graphemes: 201 };
    }
  }
}

/** Random observation with every field replaced by a junk value with some probability. */
export function junkObservation(rng: SeededRng): Malformed {
  const fields: (keyof DriftObservation)[] = [
    "deviceModel",
    "osVersion",
    "envelopeVerdict",
    "strokeType",
    "fps",
    "resolutionShortSidePx",
    "playerApparentSizeFrac",
    "coverageFrac",
    "abstentionRate",
    "latencyMs",
    "targetLockSuccessRate",
    "eventDensityPerMin",
    "paddleVisibilityFrac",
  ];
  const out: Malformed = {};
  for (const field of fields) {
    if (rng.bool(0.3)) continue;
    out[field] = rng.bool(0.5)
      ? junkValue(rng)
      : rng.bool()
        ? word(rng)
        : rng.next() * 10_000 - 100;
  }
  if (rng.bool(0.1)) out[word(rng, 8)] = junkValue(rng);
  return out;
}

/** Random non-negative count record with a few well-formed bins. */
export function countRecord(rng: SeededRng, bins: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const bin of bins) if (rng.bool(0.8)) out[bin] = rng.int(0, 5000);
  return out;
}
