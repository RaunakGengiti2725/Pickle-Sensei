/**
 * SYNTHETIC STRESS FIXTURES — generated in-process from a seed. They are NOT
 * real telemetry, real users, real devices or real media, and must never be
 * cited as evidence about the production population. They exist only to
 * drive the redaction guard, the buffered sink and the drift monitor through
 * a large, replayable input space.
 */
import { CHECKPOINTS, SHOT_TYPES } from "@pickle/shared-types";
import {
  ABSTENTION_REASON_CATEGORIES,
  MAX_ANALYTICS_ARRAY_LENGTH,
  MAX_ANALYTICS_STRING_LENGTH,
  type AnalyticsEvent,
  type DriftObservation,
  type PrivacyViolation,
} from "../../src/index.js";
import type { SeededRng } from "./seededRng.js";

const AT_BASE_MS = Date.UTC(2026, 8, 5, 0, 0, 0);

/** Clean vocabulary: short categorical labels that must never trip a rule. */
const SAFE_WORDS = [
  "pose_extraction_error",
  "transcode_failed",
  "network_timeout",
  "internal",
  "unauthorized",
  "media.process",
  "account.delete",
  "stroke-heuristic-2",
  "capture-envelope-thresholds-v0.1-provisional",
  "D-027",
  "brightness",
  "motion_blur",
  "framing",
  "phone_high",
  "phone_mid",
  "tablet",
  "1.4.0 (312)",
  "weekly_review_share",
  "after_second_free_rating",
  "pickle_sensei_pro_monthly",
  "pickle_sensei_pro_yearly",
  "media",
  "deletion",
  "beginner",
  "intermediate",
  "right",
  "left",
  "consistency",
  "power",
  "GET",
  "POST",
  "DELETE",
  "/v1/shots/:id",
  "/v1/me/access",
  "/v1/account/bootstrap",
  "unmatched",
];

function isoAt(rng: SeededRng): string {
  return new Date(AT_BASE_MS + rng.int(0, 86_400_000 * 30)).toISOString();
}

function hexFingerprint(rng: SeededRng): string {
  let out = "";
  for (let i = 0; i < 16; i++) out += rng.int(0, 15).toString(16);
  return out;
}

function safeWord(rng: SeededRng): string {
  return rng.pick(SAFE_WORDS);
}

function base(rng: SeededRng): {
  at: string;
  sessionId?: string;
  appBuild?: string;
  platform?: "ios" | "android" | "service";
  deviceClass?: string;
} {
  const out: ReturnType<typeof base> = { at: isoAt(rng) };
  if (rng.chance(0.5)) out.sessionId = hexFingerprint(rng);
  if (rng.chance(0.5)) out.appBuild = "1.4.0 (312)";
  if (rng.chance(0.5)) out.platform = rng.pick(["ios", "android", "service"] as const);
  if (rng.chance(0.5)) out.deviceClass = rng.pick(["phone_high", "phone_mid", "phone_low"]);
  return out;
}

/** One well-formed member of the AnalyticsEvent union, chosen at random. */
export function cleanEvent(rng: SeededRng): AnalyticsEvent {
  const b = base(rng);
  const shotType = rng.pick(SHOT_TYPES);
  const checkpoint = rng.pick(CHECKPOINTS);
  const kind = rng.int(0, 21);
  switch (kind) {
    case 0:
      return { ...b, name: "app_opened" };
    case 1:
      return { ...b, name: "onboarding_completed", skillLevel: safeWord(rng), handedness: "right" };
    case 2:
      return { ...b, name: "shot_type_selected", shotType };
    case 3:
      return { ...b, name: "camera_preflight_passed", attempts: rng.int(1, 5) };
    case 4:
      return {
        ...b,
        name: "capture_started",
        mode: rng.pick(["single", "live", "import"] as const),
      };
    case 5:
      return {
        ...b,
        name: "analysis_started",
        inferenceMode: rng.pick(["on_device", "cloud_deep"] as const),
        modelVersion: "stroke-heuristic-2",
      };
    case 6:
      return {
        ...b,
        name: "analysis_completed",
        shotType,
        confidenceBand: rng.pick(["normal", "lower"] as const),
        latencyMs: rng.int(100, 30_000),
        modelVersion: "stroke-heuristic-2",
      };
    case 7:
      return {
        ...b,
        name: "analysis_failed",
        failureKind: safeWord(rng),
        latencyMs: rng.int(0, 5000),
      };
    case 8:
      return {
        ...b,
        name: "analysis_abstained",
        reasonCategory: rng.pick(ABSTENTION_REASON_CATEGORIES),
        latencyMs: rng.int(0, 20_000),
      };
    case 9:
      return {
        ...b,
        name: "capture_envelope_verdict",
        overall: rng.pick(["SUPPORTED", "DEGRADED", "UNSUPPORTED"] as const),
        failedDimensions: Array.from({ length: rng.int(0, 4) }, () => safeWord(rng)),
        notMeasuredCount: rng.int(0, 6),
        thresholdsVersion: "capture-envelope-thresholds-v0.1-provisional",
      };
    case 10:
      return {
        ...b,
        name: "target_lock_failed",
        reason: rng.pick(["no_lock", "ambiguity_timeout"] as const),
        ambiguityEntered: rng.chance(0.5),
        timeToFailMs: rng.int(0, 10_000),
        algorithmVersion: "D-027",
      };
    case 11:
      return { ...b, name: "app_crash", fingerprint: hexFingerprint(rng), fatal: rng.chance(0.5) };
    case 12:
      return { ...b, name: "worker_failure", jobKind: safeWord(rng), failureKind: safeWord(rng) };
    case 13:
      return {
        ...b,
        name: "queue_backlog",
        queue: rng.pick(["media", "deletion"]),
        depth: rng.int(0, 10_000),
        oldestJobAgeMs: rng.int(0, 3_600_000),
      };
    case 14:
      return {
        ...b,
        name: "queue_stalled",
        queue: "media",
        reason: rng.pick(["no_progress", "oldest_job_age_exceeded"] as const),
        depth: rng.int(1, 500),
        consecutiveIdleCycles: rng.int(1, 50),
      };
    case 15:
      return {
        ...b,
        name: "deletion_backlog",
        pending: rng.int(0, 100),
        oldestAgeSeconds: rng.int(0, 86_400),
        exhausted: rng.int(0, 5),
      };
    case 16:
      return {
        ...b,
        name: "api_failure",
        route: rng.pick(["/v1/shots/:id", "/v1/me/access", "unmatched"]),
        method: rng.pick(["GET", "POST", "DELETE"]),
        statusCode: rng.pick([401, 403, 500, 502, 503]),
        errorCode: safeWord(rng),
        flagStateHash: hexFingerprint(rng),
      };
    case 17:
      return { ...b, name: "checkpoint_opened", checkpoint };
    case 18:
      return { ...b, name: "paywall_viewed", placement: safeWord(rng) };
    case 19:
      return { ...b, name: "subscription_started", productKey: "pickle_sensei_pro_monthly" };
    case 20:
      return { ...b, name: "cloud_sync_enabled", enabled: rng.chance(0.5) };
    default:
      return { ...b, name: "score_viewed", shotType };
  }
}

export type InjectedRule = PrivacyViolation["rule"];

export const INJECTABLE_RULES: readonly InjectedRule[] = [
  "uri_scheme",
  "filesystem_path",
  "email_address",
  "base64_blob",
  "oversized_string",
  "oversized_array",
  "forbidden_key",
];

const FORBIDDEN_KEYS = [
  "uri",
  "url",
  "path",
  "filePath",
  "fileUri",
  "objectKey",
  "masterKey",
  "email",
  "phone",
  "address",
  "deviceId",
  "idfa",
  "aaid",
  "serial",
  "stack",
  "stackTrace",
  "rawFrame",
  "imageData",
  "videoData",
  "poseFrames",
];

/** A string value that must trigger exactly the named string rule. */
export function violatingString(rng: SeededRng, rule: InjectedRule): string {
  switch (rule) {
    case "uri_scheme":
      // Shapes the URI_SCHEME rule matches (`scheme:/` or `scheme://`).
      // Real-world `blob:<origin>/…` and `data:<mime>;base64,…` forms are
      // NOT in this list: they are pinned separately in
      // redactionUriGap.stress.test.ts because the guard misses them.
      return rng.pick([
        "file:///var/mobile/Containers/clip.mov",
        "content://media/external/video/1234",
        "ph://ABCDEF-1234/L0/001",
        "s3://pickle-media/clip.mp4",
        "assets-library://asset/asset.MOV?id=ABC&ext=MOV",
        "blob://synthetic/uuid",
      ]);
    case "filesystem_path":
      return rng.pick([
        "ENOENT /var/data/media/user-123/master.mp4",
        "read /private/var/mobile/clip.mov",
        "open /Users/coach/Movies/clip.mov",
        "stat /tmp/pickle/clip.mov",
        "/home/worker/media/clip.mp4",
      ]);
    case "email_address":
      return `contact ${safeWord(rng).replace(/[^a-z]/g, "")}${rng.int(0, 999)}@example.com`;
    case "base64_blob": {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      let out = "";
      const len = rng.int(120, 190);
      for (let i = 0; i < len; i++) out += alphabet[rng.int(0, alphabet.length - 1)];
      return out;
    }
    case "oversized_string":
      // Whitespace-separated so no other string rule fires.
      return "x y ".repeat(Math.ceil((MAX_ANALYTICS_STRING_LENGTH + rng.int(1, 200)) / 4));
    default:
      throw new Error(`violatingString: ${rule} is not a string rule`);
  }
}

export interface InjectedViolation {
  rule: InjectedRule;
  path: string;
}

/**
 * Take a clean event and smuggle exactly one violation into it at a random
 * (possibly nested) location. Returns the mutated event and the oracle
 * (path + rule) the guard must report. The event is deliberately cast: the
 * guard is structural and must catch payloads the type system would reject.
 */
export function injectViolation(
  rng: SeededRng,
  event: AnalyticsEvent,
  rule: InjectedRule,
): { event: AnalyticsEvent; injected: InjectedViolation } {
  const mutable = { ...event } as Record<string, unknown>;
  const nested = rng.chance(0.4);
  let target: Record<string, unknown> = mutable;
  let prefix = "";
  if (nested) {
    const depth = rng.int(1, 3);
    for (let d = 0; d < depth; d++) {
      const key = `ctx${d}`;
      const child: Record<string, unknown> = {};
      target[key] = child;
      target = child;
      prefix = prefix === "" ? key : `${prefix}.${key}`;
    }
  }
  let key: string;
  let path: string;
  switch (rule) {
    case "forbidden_key":
      key = rng.pick(FORBIDDEN_KEYS);
      target[key] = safeWord(rng);
      path = prefix === "" ? key : `${prefix}.${key}`;
      break;
    case "oversized_array": {
      key = "dims";
      target[key] = Array.from({ length: MAX_ANALYTICS_ARRAY_LENGTH + rng.int(1, 40) }, () =>
        safeWord(rng),
      );
      path = prefix === "" ? key : `${prefix}.${key}`;
      break;
    }
    default: {
      key = rng.pick(["detail", "reasonText", "failureKind", "note"]);
      const inArray = rng.chance(0.3);
      const value = violatingString(rng, rule);
      if (inArray) {
        const idx = rng.int(0, 3);
        const arr = Array.from({ length: idx + 1 }, () => safeWord(rng));
        arr[idx] = value;
        target[key] = arr;
        path = `${prefix === "" ? key : `${prefix}.${key}`}[${idx}]`;
      } else {
        target[key] = value;
        path = prefix === "" ? key : `${prefix}.${key}`;
      }
    }
  }
  return { event: mutable as unknown as AnalyticsEvent, injected: { rule, path } };
}

export interface SyntheticEvent {
  event: AnalyticsEvent;
  injected: InjectedViolation | null;
}

/** A batch of events; `violationRate` of them carry one injected violation. */
export function eventBatch(rng: SeededRng, count: number, violationRate: number): SyntheticEvent[] {
  const out: SyntheticEvent[] = [];
  for (let i = 0; i < count; i++) {
    const clean = cleanEvent(rng);
    if (rng.chance(violationRate)) {
      out.push(injectViolation(rng, clean, rng.pick(INJECTABLE_RULES)));
    } else {
      out.push({ event: clean, injected: null });
    }
  }
  return out;
}

/** Parameters of one synthetic drift population (all aggregate-safe). */
export interface DriftPopulation {
  deviceModels: string[];
  osVersions: string[];
  verdicts: string[];
  strokes: string[];
  /** Per numeric field: [lo, hi) range the values are drawn from. */
  numeric: Record<
    | "fps"
    | "resolutionShortSidePx"
    | "playerApparentSizeFrac"
    | "coverageFrac"
    | "abstentionRate"
    | "latencyMs"
    | "targetLockSuccessRate"
    | "eventDensityPerMin"
    | "paddleVisibilityFrac",
    [number, number]
  >;
  /** Probability a field is missing / non-finite in an observation. */
  missingRate: number;
  nonFiniteRate: number;
}

export function driftPopulation(rng: SeededRng): DriftPopulation {
  const labels = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `synthetic-${prefix}-${i}`);
  const range = (lo: number, hi: number): [number, number] => {
    const a = rng.float(lo, hi);
    const b = rng.float(lo, hi);
    return a <= b ? [a, b + 1e-9] : [b, a + 1e-9];
  };
  return {
    deviceModels: labels("device", rng.int(1, 50)),
    osVersions: labels("os", rng.int(1, 8)),
    verdicts: ["SUPPORTED", "DEGRADED", "UNSUPPORTED"].slice(0, rng.int(1, 3)),
    strokes: [...SHOT_TYPES].slice(0, rng.int(1, SHOT_TYPES.length)),
    numeric: {
      fps: range(0, 240),
      resolutionShortSidePx: range(0, 4320),
      playerApparentSizeFrac: range(0, 1),
      coverageFrac: range(0, 1),
      abstentionRate: range(0, 1),
      latencyMs: range(0, 60_000),
      targetLockSuccessRate: range(0, 1),
      eventDensityPerMin: range(0, 60),
      paddleVisibilityFrac: range(0, 1),
    },
    missingRate: rng.chance(0.3) ? rng.float(0, 0.5) : 0,
    nonFiniteRate: rng.chance(0.3) ? rng.float(0, 0.2) : 0,
  };
}

const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

export function driftObservation(rng: SeededRng, pop: DriftPopulation): DriftObservation {
  const obs: DriftObservation = {};
  const cat = (values: string[]): string | undefined =>
    rng.chance(pop.missingRate) ? undefined : rng.pick(values);
  const num = (r: [number, number]): number | undefined => {
    if (rng.chance(pop.missingRate)) return undefined;
    if (rng.chance(pop.nonFiniteRate)) return rng.pick(NON_FINITE);
    if (rng.chance(0.02)) return rng.pick([-1, 0, 1e308, -1e308, 5e-324]);
    return rng.float(r[0], r[1]);
  };
  const dm = cat(pop.deviceModels);
  if (dm !== undefined) obs.deviceModel = dm;
  const os = cat(pop.osVersions);
  if (os !== undefined) obs.osVersion = os;
  const ev = cat(pop.verdicts);
  if (ev !== undefined) obs.envelopeVerdict = ev;
  const st = cat(pop.strokes);
  if (st !== undefined) obs.strokeType = st;
  for (const field of Object.keys(pop.numeric) as (keyof DriftPopulation["numeric"])[]) {
    const v = num(pop.numeric[field]);
    if (v !== undefined) obs[field] = v;
  }
  return obs;
}
