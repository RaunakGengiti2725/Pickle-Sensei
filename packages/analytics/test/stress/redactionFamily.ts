import { CHECKPOINTS, SHOT_TYPES } from "@pickle/shared-types";
import {
  ABSTENTION_REASON_CATEGORIES,
  ANALYTICS_EVENT_NAMES,
  BufferedAnalytics,
  findPrivacyViolations,
  MAX_ANALYTICS_ARRAY_LENGTH,
  MAX_ANALYTICS_STRING_LENGTH,
  type AnalyticsEvent,
  type AnalyticsEventName,
  type PrivacyViolation,
} from "../../src/index.js";
import type { Failure, Family, Replay } from "./campaign.js";
import { bump, stableJson } from "./campaign.js";
import type { Rng } from "./rng.js";

/**
 * Family `redaction`: legal + near-legal event streams through
 * `findPrivacyViolations` and `BufferedAnalytics` with a transport that is
 * randomly healthy / failing / holding batches in flight.
 *
 * Invariants (from `packages/analytics/src/index.ts` doc comments, AGENTS.md
 * "telemetry never carries media/URIs/paths/emails/free text/base64/device
 * IDs" and REVIEW.md "analytics payloads are categorical"):
 *
 *  R-GUARD-CLEAN      a legal event (only enumerated categorical fields and
 *                     bounded numbers) yields zero violations
 *  R-GUARD-SPEC       a planted payload the documented rules must catch
 *                     (regex text of index.ts) yields ≥1 violation
 *  R-GUARD-PROBE      a planted payload the guard INTENDS to catch (its
 *                     comments: URI schemes incl. data:/blob:, filesystem
 *                     paths, base64 blobs, identifier keys) but whose exact
 *                     regex is doubtful yields ≥1 violation
 *  R-SINK-NO-THROW    track()/flush() never throw or reject
 *  R-SINK-FLAGGED-DROPPED  an event the guard flagged never reaches the transport
 *  R-SINK-DELIVERED-CLEAN  every event handed to the transport passes the guard
 *  R-SINK-COUNTERS    droppedViolationCount() == flagged events and
 *                     onViolation fired once per flagged event, with its name
 *  R-SINK-NO-DUP      a clean event is delivered at most once
 *  R-SINK-CONSERVE    clean == delivered + pending + inflight + retryLoss where
 *                     retryLoss = Σ max(0, failedBatch − maxBuffer) (the
 *                     documented `slice(-maxBuffer)` re-buffer)
 *  R-SINK-NO-SILENT-LOSS  retryLoss == 0 — a clean event that was tracked and
 *                     never delivered must be observable through a counter
 *  R-SINK-DRAIN       with a healthy transport, flush() empties the buffer and
 *                     delivered + retryLoss == clean
 */

export const REDACTION_INVARIANTS = [
  "R-GUARD-CLEAN",
  "R-GUARD-SPEC",
  "R-GUARD-PROBE",
  "R-SINK-NO-THROW",
  "R-SINK-FLAGGED-DROPPED",
  "R-SINK-DELIVERED-CLEAN",
  "R-SINK-COUNTERS",
  "R-SINK-NO-DUP",
  "R-SINK-CONSERVE",
  "R-SINK-NO-SILENT-LOSS",
  "R-SINK-DRAIN",
] as const;

export type TransportMode = "ok" | "fail" | "failSync" | "hold";

export interface Plant {
  /** "spec" = documented regex must catch; "probe" = guard intent must catch. */
  expectation: "spec" | "probe";
  kind: string;
  rule: PrivacyViolation["rule"];
  sentinel: string;
  path: string;
}

export type RedactionOp =
  | { op: "sink"; maxBuffer: number }
  | { op: "track"; id: string; event: Record<string, unknown>; plant: Plant | null }
  | { op: "flush" }
  | { op: "transport"; mode: TransportMode }
  | { op: "release"; outcome: "ok" | "fail" };

const PLATFORMS = ["ios", "android", "service"] as const;
const DEVICE_CLASSES = ["phone_high", "phone_mid", "phone_low", "tablet", "server"] as const;
const OVERALL = ["SUPPORTED", "DEGRADED", "UNSUPPORTED"] as const;
const DIMENSIONS = [
  "brightness",
  "fps",
  "resolution",
  "player_size",
  "coverage",
  "occlusion",
  "camera_angle",
] as const;
const FAILURE_KINDS = [
  "queue_unavailable",
  "media_decode",
  "storage_missing",
  "db_write",
  "pipeline_timeout",
  "unknown",
] as const;
const JOB_KINDS = ["transcode", "analyze", "purge", "export"] as const;
const QUEUES = ["media", "deletion", "export"] as const;
const DRILLS = [
  "dink-wall-30",
  "third-shot-ladder",
  "serve-target-box",
  "volley-reaction",
] as const;
const PRODUCTS = [
  "pickle_sensei_pro_monthly",
  "pickle_sensei_pro_yearly",
  "pickle_sensei_pro_lifetime",
] as const;
const PLACEMENTS = ["onboarding", "result_screen", "settings", "third_rating"] as const;
const TEMPLATES = ["score_card", "streak", "weekly"] as const;
const VOICE_CATEGORIES = ["ready", "contact", "recover", "praise"] as const;
const HTTP_METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;
const ROUTES = [
  "/v1/shots/:id",
  "/v1/me/access",
  "/v1/account/bootstrap",
  "/v1/auth/refresh",
] as const;

function iso(rng: Rng): string {
  const t = Date.UTC(
    2026,
    rng.int(0, 11),
    rng.int(1, 28),
    rng.int(0, 23),
    rng.int(0, 59),
    rng.int(0, 59),
  );
  return new Date(t).toISOString();
}

function version(rng: Rng): string {
  return `${rng.int(0, 3)}.${rng.int(0, 20)}.${rng.int(0, 99)}`;
}

/** Legal event bodies per name (the union in src/index.ts): categoricals + bounded numbers only. */
function legalEvent(rng: Rng, name: AnalyticsEventName, id: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name,
    at: iso(rng),
    sessionId: id,
  };
  if (rng.chance(0.7)) base["platform"] = rng.pick(PLATFORMS);
  if (rng.chance(0.5)) base["appBuild"] = `${version(rng)} (${rng.int(1, 999)})`;
  if (rng.chance(0.5)) base["deviceClass"] = rng.pick(DEVICE_CLASSES);
  const shot = () => rng.pick(SHOT_TYPES);
  const checkpoint = () => rng.pick(CHECKPOINTS);
  const ms = () => rng.int(0, 120_000);
  const maybe = (key: string, value: unknown) => {
    if (rng.chance(0.6)) base[key] = value;
  };
  switch (name) {
    case "app_opened":
    case "onboarding_started":
    case "camera_preflight_started":
    case "worker_started":
    case "weekly_review_viewed":
    case "friend_request_sent":
    case "account_export_requested":
    case "account_delete_requested":
      return base;
    case "onboarding_completed":
      return {
        ...base,
        skillLevel: rng.pick(["beginner", "intermediate", "advanced"]),
        handedness: rng.pick(["left", "right"]),
      };
    case "goal_selected":
      return { ...base, goal: rng.pick(["consistency", "power", "placement"]) };
    case "shot_type_selected":
    case "shot_detected":
    case "analysis_low_confidence":
    case "score_viewed":
      return { ...base, shotType: shot() };
    case "camera_preflight_passed":
      return { ...base, attempts: rng.int(1, 5) };
    case "capture_started":
      return { ...base, mode: rng.pick(["single", "live", "import"]) };
    case "analysis_started":
      maybe("modelVersion", `pose-${version(rng)}`);
      return { ...base, inferenceMode: rng.pick(["on_device", "cloud_deep"]) };
    case "analysis_completed":
      maybe("latencyMs", ms());
      maybe("modelVersion", `pose-${version(rng)}`);
      return { ...base, shotType: shot(), confidenceBand: rng.pick(["normal", "lower"]) };
    case "analysis_failed":
      maybe("latencyMs", ms());
      return { ...base, failureKind: rng.pick(FAILURE_KINDS) };
    case "analysis_abstained":
      maybe("latencyMs", ms());
      return { ...base, reasonCategory: rng.pick(ABSTENTION_REASON_CATEGORIES) };
    case "capture_envelope_verdict":
      return {
        ...base,
        overall: rng.pick(OVERALL),
        failedDimensions: Array.from({ length: rng.int(0, 4) }, () => rng.pick(DIMENSIONS)),
        notMeasuredCount: rng.int(0, 3),
        thresholdsVersion: `envelope-${version(rng)}`,
      };
    case "target_lock_failed":
      maybe("timeToFailMs", ms());
      return {
        ...base,
        reason: rng.pick(["no_lock", "ambiguity_timeout"]),
        ambiguityEntered: rng.chance(0.5),
        algorithmVersion: `lock-${version(rng)}`,
      };
    case "event_proposal_failed":
      return { ...base, reasonCategory: rng.pick(["no_event_proposed", "event_rejected"]) };
    case "app_crash":
      return { ...base, fingerprint: rng.token(16), fatal: rng.chance(0.5) };
    case "worker_failure":
      return { ...base, jobKind: rng.pick(JOB_KINDS), failureKind: rng.pick(FAILURE_KINDS) };
    case "queue_backlog":
      maybe("oldestJobAgeMs", ms());
      return { ...base, queue: rng.pick(QUEUES), depth: rng.int(0, 10_000) };
    case "queue_stalled":
      maybe("oldestJobAgeMs", ms());
      return {
        ...base,
        queue: rng.pick(QUEUES),
        reason: rng.pick(["no_progress", "oldest_job_age_exceeded"]),
        depth: rng.int(0, 10_000),
        consecutiveIdleCycles: rng.int(1, 50),
      };
    case "worker_crash":
      return { ...base, crashCount: rng.int(0, 20) };
    case "deletion_backlog":
      maybe("oldestAgeSeconds", rng.int(0, 86_400));
      return { ...base, pending: rng.int(0, 500), exhausted: rng.int(0, 10) };
    case "media_storage_failure":
      return { ...base, operation: rng.pick(["purge", "sweep", "transcode"]) };
    case "api_failure":
      maybe("flagStateHash", rng.token(12));
      return {
        ...base,
        route: rng.pick(ROUTES),
        method: rng.pick(HTTP_METHODS),
        statusCode: rng.pick([401, 403, 500, 502, 503]),
        errorCode: rng.pick(["unauthorized", "forbidden", "internal", "upstream_unavailable"]),
      };
    case "checkpoint_opened":
      return { ...base, checkpoint: checkpoint() };
    case "drill_opened":
    case "drill_started":
    case "drill_completed":
      return { ...base, drillSlug: rng.pick(DRILLS) };
    case "live_court_started":
      return { ...base, shotType: shot(), focus: checkpoint() };
    case "live_shot_scored":
      return { ...base, repIndex: rng.int(0, 200) };
    case "voice_cue_played":
      return { ...base, category: rng.pick(VOICE_CATEGORIES) };
    case "live_session_completed":
      return { ...base, validShots: rng.int(0, 200), durationSec: rng.int(0, 3600) };
    case "share_created":
      return { ...base, templateKey: rng.pick(TEMPLATES) };
    case "paywall_viewed":
      return { ...base, placement: rng.pick(PLACEMENTS) };
    case "trial_started":
    case "subscription_started":
    case "subscription_renewed":
    case "subscription_cancelled":
      return { ...base, productKey: rng.pick(PRODUCTS) };
    case "cloud_sync_enabled":
      return { ...base, enabled: rng.chance(0.5) };
    case "ml_training_consent_changed":
      return { ...base, granted: rng.chance(0.5) };
  }
}

const SPEC_SCHEMES = [
  "file:///",
  "FILE:///",
  "content://",
  "Content://",
  "ph://",
  "assets-library://",
  "s3://",
] as const;
const SPEC_ROOTS = [
  "/var/",
  "/private/",
  "/Users/",
  "/data/",
  "/storage/",
  "/tmp/",
  "/home/",
] as const;
const SPEC_PATH_PREFIXES = ["", " ", "=", '"', "'", "(", "\t"] as const;
const PROBE_PATH_PREFIXES = [":", "[", ",", ";", "<", "{", "|", "→", "\\"] as const;
const PROBE_ROOTS = [
  "/mnt/",
  "/srv/",
  "/opt/",
  "/Library/",
  "/Volumes/",
  "/root/",
  "/media/",
  "/sdcard/",
] as const;
const FORBIDDEN_KEYS_SPEC = [
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
  "URI",
  "Url",
  "PATH",
  "FILEPATH",
  "EMAIL",
  "DeviceID",
] as const;
const FORBIDDEN_KEYS_PROBE = [
  "fileUrl",
  "videoUrl",
  "imageUrl",
  "mediaUri",
  "localPath",
  "emailAddress",
  "userEmail",
  "phoneNumber",
  "ipAddress",
  "advertisingId",
  "stack_trace",
  "device_id",
  "keypoints",
  "poseFrame",
  "thumbnail",
] as const;

function words(rng: Rng, minLength: number): string {
  let out = "";
  while (out.length < minLength) out += `${rng.token(rng.int(2, 7))} `;
  return out;
}

/** String fields a payload can be planted into (sessionId stays the event id). */
function stringFieldsOf(event: Record<string, unknown>): string[] {
  const fields = Object.entries(event)
    .filter(
      ([key, value]) =>
        typeof value === "string" && key !== "name" && key !== "at" && key !== "sessionId",
    )
    .map(([key]) => key);
  return fields.length > 0 ? fields : ["deviceClass"];
}

/** Generate a planted payload; returns the (mutated) event and plant descriptor. */
function plantInto(rng: Rng, event: Record<string, unknown>): Plant {
  const target = rng.pick(stringFieldsOf(event));
  const tok = rng.token(rng.int(4, 12));
  const setString = (
    value: string,
    kind: string,
    rule: PrivacyViolation["rule"],
    expectation: Plant["expectation"],
  ) => {
    event[target] = value;
    return { expectation, kind, rule, sentinel: tok, path: target };
  };
  const choice = rng.weighted<
    | "email"
    | "scheme"
    | "path"
    | "base64"
    | "oversized"
    | "array"
    | "key"
    | "probe_data"
    | "probe_blob"
    | "probe_path_prefix"
    | "probe_root"
    | "probe_base64url"
    | "probe_key"
  >([
    [12, "email"],
    [12, "scheme"],
    [12, "path"],
    [8, "base64"],
    [6, "oversized"],
    [4, "array"],
    [12, "key"],
    [6, "probe_data"],
    [5, "probe_blob"],
    [6, "probe_path_prefix"],
    [5, "probe_root"],
    [4, "probe_base64url"],
    [8, "probe_key"],
  ]);
  switch (choice) {
    case "email":
      return setString(
        rng.chance(0.5) ? `qa-${tok}@example.com` : `failed for QA-${tok}@sub.example.co.uk today`,
        "email",
        "email_address",
        "spec",
      );
    case "scheme":
      return setString(
        `${rng.pick(SPEC_SCHEMES)}${rng.pick(["var/mobile/", "media/", ""])}${tok}.mov`,
        "uri_scheme",
        "uri_scheme",
        "spec",
      );
    case "path":
      return setString(
        `${rng.pick(SPEC_PATH_PREFIXES)}${rng.pick(SPEC_ROOTS)}${tok}/clip.mov`,
        "fs_path",
        "filesystem_path",
        "spec",
      );
    case "base64": {
      const blob = rng.base64Run(rng.int(120, MAX_ANALYTICS_STRING_LENGTH - 1));
      const plant = setString(blob, "base64", "base64_blob", "spec");
      plant.sentinel = blob;
      return plant;
    }
    case "oversized": {
      const text = words(rng, MAX_ANALYTICS_STRING_LENGTH + rng.int(1, 200));
      const plant = setString(text, "oversized_string", "oversized_string", "spec");
      plant.sentinel = text;
      return plant;
    }
    case "array": {
      const arr = Array.from({ length: MAX_ANALYTICS_ARRAY_LENGTH + rng.int(1, 20) }, () =>
        rng.pick(DIMENSIONS),
      );
      event["failedDimensions"] = arr;
      return {
        expectation: "spec",
        kind: "oversized_array",
        rule: "oversized_array",
        sentinel: `${arr.length}`,
        path: "failedDimensions",
      };
    }
    case "key": {
      const key = rng.pick(FORBIDDEN_KEYS_SPEC);
      event[key] = `k-${tok}`;
      return {
        expectation: "spec",
        kind: "forbidden_key",
        rule: "forbidden_key",
        sentinel: `k-${tok}`,
        path: key,
      };
    }
    case "probe_data": {
      const blob = rng.base64Run(rng.int(24, 100));
      const plant = setString(
        `data:image/${rng.pick(["png", "jpeg"])};base64,${blob}`,
        "data_uri",
        "uri_scheme",
        "probe",
      );
      plant.sentinel = blob;
      return plant;
    }
    case "probe_blob":
      return setString(
        `blob:https://app.local/${tok}-4f1e-8a3c`,
        "blob_url",
        "uri_scheme",
        "probe",
      );
    case "probe_path_prefix":
      return setString(
        `error${rng.pick(PROBE_PATH_PREFIXES)}${rng.pick(SPEC_ROOTS)}${tok}/clip.mov`,
        "fs_path_prefix",
        "filesystem_path",
        "probe",
      );
    case "probe_root":
      return setString(
        `${rng.pick(SPEC_PATH_PREFIXES)}${rng.pick(PROBE_ROOTS)}${tok}/clip.mov`,
        "fs_path_root",
        "filesystem_path",
        "probe",
      );
    case "probe_base64url": {
      const blob = rng
        .base64Run(rng.int(120, MAX_ANALYTICS_STRING_LENGTH - 1))
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
      const plant = setString(blob, "base64url", "base64_blob", "probe");
      plant.sentinel = blob;
      return plant;
    }
    case "probe_key": {
      const key = rng.pick(FORBIDDEN_KEYS_PROBE);
      event[key] = `k-${tok}`;
      return {
        expectation: "probe",
        kind: "forbidden_key_synonym",
        rule: "forbidden_key",
        sentinel: `k-${tok}`,
        path: key,
      };
    }
  }
}

export function generateRedactionOps(rng: Rng, length: number): RedactionOp[] {
  const ops: RedactionOp[] = [{ op: "sink", maxBuffer: rng.pick([1, 2, 3, 5, 8, 13, 50]) }];
  let counter = 0;
  while (ops.length < length) {
    const kind = rng.weighted<RedactionOp["op"]>([
      [58, "track"],
      [12, "flush"],
      [12, "transport"],
      [14, "release"],
      [4, "sink"],
    ]);
    switch (kind) {
      case "track": {
        const id = `ev-${counter++}`;
        const event = legalEvent(rng, rng.pick(ANALYTICS_EVENT_NAMES), id);
        const plant = rng.chance(0.35) ? plantInto(rng, event) : null;
        ops.push({ op: "track", id, event, plant });
        break;
      }
      case "flush":
        ops.push({ op: "flush" });
        break;
      case "transport":
        ops.push({
          op: "transport",
          mode: rng.pick(["ok", "ok", "fail", "failSync", "hold", "hold"]),
        });
        break;
      case "release":
        ops.push({ op: "release", outcome: rng.chance(0.6) ? "ok" : "fail" });
        break;
      case "sink":
        ops.push({ op: "sink", maxBuffer: rng.pick([1, 2, 3, 5, 8, 13, 50]) });
        break;
    }
  }
  return ops;
}

interface Held {
  batch: AnalyticsEvent[];
  resolve: () => void;
  reject: (error: Error) => void;
}

interface SinkModel {
  sink: BufferedAnalytics;
  maxBuffer: number;
  mode: TransportMode;
  held: Held[];
  delivered: Map<string, number>;
  deliveredBatches: AnalyticsEvent[][];
  failedBatchSizes: number[];
  clean: Set<string>;
  flagged: Set<string>;
  flaggedEvents: Map<string, Plant | null>;
  onViolationNames: AnalyticsEventName[];
  /** Delivered batches already checked by `checkSink` (so each is reported once). */
  checkedBatches: number;
  /** Retry loss already reported (so each loss is reported once). */
  reportedLoss: number;
  /** flush() promises started while a batch was held (they settle on release). */
  flushes: Promise<void>[];
}

/** Let flush()'s awaited transport settle (rejections are handled in a microtask). */
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

function eventId(event: AnalyticsEvent): string {
  return typeof event.sessionId === "string" ? event.sessionId : "?";
}

function newSink(maxBuffer: number): SinkModel {
  // `model` is only dereferenced from callbacks, which BufferedAnalytics never
  // invokes during construction, so the self-reference below is safe.
  const model: SinkModel = {
    sink: new BufferedAnalytics(
      (batch) => transport(batch),
      maxBuffer,
      (name) => {
        model.onViolationNames.push(name);
      },
    ),
    maxBuffer,
    mode: "ok",
    held: [],
    delivered: new Map(),
    deliveredBatches: [],
    failedBatchSizes: [],
    clean: new Set(),
    flagged: new Set(),
    flaggedEvents: new Map(),
    onViolationNames: [],
    checkedBatches: 0,
    reportedLoss: 0,
    flushes: [],
  };
  const deliver = (batch: AnalyticsEvent[]) => {
    model.deliveredBatches.push(batch);
    for (const event of batch) {
      const id = eventId(event);
      model.delivered.set(id, (model.delivered.get(id) ?? 0) + 1);
    }
  };
  const transport = (batch: AnalyticsEvent[]): Promise<void> => {
    switch (model.mode) {
      case "ok":
        deliver(batch);
        return Promise.resolve();
      case "fail":
        model.failedBatchSizes.push(batch.length);
        return Promise.reject(new Error("transport down"));
      case "failSync":
        model.failedBatchSizes.push(batch.length);
        throw new Error("transport threw synchronously");
      case "hold":
        return new Promise<void>((resolve, reject) => {
          model.held.push({
            batch,
            resolve: () => {
              deliver(batch);
              resolve();
            },
            reject: (error) => {
              model.failedBatchSizes.push(batch.length);
              reject(error);
            },
          });
        });
    }
  };
  return model;
}

function retryLoss(model: SinkModel): number {
  return model.failedBatchSizes.reduce((sum, size) => sum + Math.max(0, size - model.maxBuffer), 0);
}

function inflight(model: SinkModel): number {
  return model.held.reduce((sum, h) => sum + h.batch.length, 0);
}

function checkSink(model: SinkModel, step: number, failures: Failure[]): void {
  const fail = (invariant: string, detail: string) => failures.push({ invariant, step, detail });

  if (model.sink.droppedViolationCount() !== model.flagged.size) {
    fail(
      "R-SINK-COUNTERS",
      `droppedViolationCount=${model.sink.droppedViolationCount()} flagged=${model.flagged.size}`,
    );
  }
  if (model.onViolationNames.length !== model.flagged.size) {
    fail(
      "R-SINK-COUNTERS",
      `onViolation fired ${model.onViolationNames.length}x for ${model.flagged.size} flagged`,
    );
  }
  for (const batch of model.deliveredBatches.slice(model.checkedBatches)) {
    for (const event of batch) {
      const id = eventId(event);
      if (model.flagged.has(id)) {
        fail(
          "R-SINK-FLAGGED-DROPPED",
          `flagged ${id} reached transport: ${stableJson(event).slice(0, 160)}`,
        );
      }
      const violations = findPrivacyViolations(event);
      if (violations.length > 0) {
        fail("R-SINK-DELIVERED-CLEAN", `delivered ${id} fails guard: ${stableJson(violations)}`);
      }
    }
  }
  model.checkedBatches = model.deliveredBatches.length;
  for (const [id, count] of model.delivered) {
    if (count > 1) fail("R-SINK-NO-DUP", `${id} delivered ${count}x`);
  }
  const deliveredTotal = [...model.delivered.values()].reduce((a, b) => a + b, 0);
  const loss = retryLoss(model);
  const pending = model.sink.pendingCount();
  const accounted = deliveredTotal + pending + inflight(model) + loss;
  if (accounted !== model.clean.size) {
    fail(
      "R-SINK-CONSERVE",
      `clean=${model.clean.size} delivered=${deliveredTotal} pending=${pending} inflight=${inflight(model)} retryLoss=${loss}`,
    );
  }
  if (loss > model.reportedLoss) {
    fail(
      "R-SINK-NO-SILENT-LOSS",
      `${loss} clean event(s) dropped by slice(-maxBuffer) re-buffer (maxBuffer=${model.maxBuffer}, failed batches=${model.failedBatchSizes.join(",")}); no counter exposes them`,
    );
    model.reportedLoss = loss;
  }
}

async function drain(
  model: SinkModel,
  step: number,
  failures: Failure[],
  trace: string[],
): Promise<void> {
  model.mode = "ok";
  for (const h of model.held.splice(0)) h.resolve();
  await Promise.all(model.flushes.splice(0));
  await settle();
  for (let i = 0; i < 8 && model.sink.pendingCount() > 0; i++) {
    await model.sink.flush();
    await settle();
  }
  const deliveredTotal = [...model.delivered.values()].reduce((a, b) => a + b, 0);
  const loss = retryLoss(model);
  trace.push(`drain pending=${model.sink.pendingCount()} delivered=${deliveredTotal} loss=${loss}`);
  if (model.sink.pendingCount() !== 0 || deliveredTotal + loss !== model.clean.size) {
    failures.push({
      invariant: "R-SINK-DRAIN",
      step,
      detail: `after drain pending=${model.sink.pendingCount()} delivered=${deliveredTotal} retryLoss=${loss} clean=${model.clean.size}`,
    });
  }
}

export async function runRedactionOps(ops: readonly RedactionOp[]): Promise<Replay> {
  const failures: Failure[] = [];
  const trace: string[] = [];
  const coverage: Record<string, number> = {};
  let model = newSink(50);

  for (let step = 0; step < ops.length; step++) {
    const op = ops[step];
    if (!op) continue;
    try {
      switch (op.op) {
        case "sink":
          await drain(model, step, failures, trace);
          model = newSink(op.maxBuffer);
          trace.push(`sink ${op.maxBuffer}`);
          break;
        case "track": {
          const event = op.event as unknown as AnalyticsEvent;
          const violations = findPrivacyViolations(event);
          const rules = violations.map((v) => `${v.rule}@${v.path}`).sort();
          trace.push(`track ${op.id} ${rules.join("|")}`);
          bump(
            coverage,
            op.plant ? `track.planted.${op.plant.expectation}.${op.plant.kind}` : "track.clean",
          );
          if (violations.length > 0) bump(coverage, "guard.flagged");
          for (const v of violations) bump(coverage, `guard.rule.${v.rule}`);
          if (op.plant === null && violations.length > 0) {
            failures.push({
              invariant: "R-GUARD-CLEAN",
              step,
              detail: `legal ${event.name} flagged: ${stableJson(violations)} event=${stableJson(event).slice(0, 200)}`,
            });
          }
          if (op.plant && violations.length === 0) {
            failures.push({
              invariant: op.plant.expectation === "spec" ? "R-GUARD-SPEC" : "R-GUARD-PROBE",
              step,
              detail: `${op.plant.kind} (expected ${op.plant.rule} at ${op.plant.path}) passed guard: ${stableJson(
                event[op.plant.path as keyof AnalyticsEvent],
              ).slice(0, 160)}`,
            });
          }
          if (
            op.plant &&
            op.plant.expectation === "spec" &&
            violations.length > 0 &&
            !violations.some((v) => v.rule === op.plant?.rule)
          ) {
            failures.push({
              invariant: "R-GUARD-SPEC",
              step,
              detail: `${op.plant.kind} caught by ${rules.join("|")} not ${op.plant.rule}`,
            });
          }
          model.sink.track(event);
          if (violations.length > 0) {
            model.flagged.add(op.id);
            model.flaggedEvents.set(op.id, op.plant);
          } else {
            model.clean.add(op.id);
          }
          break;
        }
        case "flush": {
          // A held transport keeps flush() pending until a later release op,
          // so wait only for the settle window rather than the promise itself.
          const flushing = model.sink.flush();
          model.flushes.push(flushing);
          await Promise.race([flushing, settle()]);
          trace.push(`flush pending=${model.sink.pendingCount()}`);
          bump(coverage, `flush.${model.mode}`);
          break;
        }
        case "transport":
          model.mode = op.mode;
          trace.push(`transport ${op.mode}`);
          break;
        case "release": {
          const h = model.held.shift();
          if (h) {
            if (op.outcome === "ok") h.resolve();
            else h.reject(new Error("held batch failed"));
          }
          trace.push(`release ${op.outcome} ${h ? h.batch.length : "none"}`);
          bump(coverage, h ? `release.${op.outcome}` : "release.noop");
          break;
        }
      }
    } catch (error) {
      failures.push({
        invariant: "R-SINK-NO-THROW",
        step,
        detail: `${op.op} threw ${String(error)}`,
      });
    }
    await settle();
    checkSink(model, step, failures);
    trace.push(
      `state pending=${model.sink.pendingCount()} dropped=${model.sink.droppedViolationCount()} inflight=${inflight(model)}`,
    );
  }
  await drain(model, ops.length, failures, trace);
  checkSink(model, ops.length, failures);
  bump(
    coverage,
    "sink.delivered",
    [...model.delivered.values()].reduce((a, b) => a + b, 0),
  );
  bump(coverage, "sink.clean", model.clean.size);
  bump(coverage, "sink.flaggedDropped", model.sink.droppedViolationCount());
  bump(coverage, "sink.failedBatches", model.failedBatchSizes.length);
  bump(coverage, "sink.retryLoss", retryLoss(model));
  return { trace: trace.join("\n"), failures, coverage };
}

export const redactionFamily: Family<RedactionOp> = {
  name: "redaction",
  generate: generateRedactionOps,
  run: runRedactionOps,
};
